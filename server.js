const express = require('express');
const acme = require('acme-client');
const crypto = require('crypto');

// ✅ 尝试直接引用 node-forge (acme-client 的依赖)
let forge;
try {
    forge = require('node-forge');
} catch (e) {
    console.warn("⚠️ 未找到 node-forge，CSR 生成可能在不兼容 Node v24 的环境中失败");
}

const app = express();
const PORT = process.env.PORT || 80;

app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

// ================= 配置与存储 =================
const SESSION_TIMEOUT = 45 * 60 * 1000;
const CLEANUP_INTERVAL = 5 * 60 * 1000;
const MAX_CONCURRENT_TASKS = 5;

const sessions = new Map();
let activeTasks = 0;
const taskQueue = [];

function createSessionId() {
    return `sess_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function log(session, type, current, next = null, details = null) {
    const entry = { ts: new Date().toISOString(), type, current, next, details };
    session.logs.push(entry);
    if (session.logs.length > 200) session.logs.shift();
}

function validateDomain(domain) {
    const regex = /^(\*\.)?([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z]{2,}$/;
    return regex.test(domain.toLowerCase());
}

function getValidatedKeyObject(inputPem, expectedType) {
    try {
        if (!inputPem || !inputPem.includes('PRIVATE KEY')) return null;
        const cleanPem = inputPem.trim();
        const keyObject = crypto.createPrivateKey(cleanPem);
        const details = keyObject.asymmetricKeyDetails || {};
        if (expectedType.startsWith('rsa')) {
            if (details.type && details.type !== 'rsa') return null;
        } else if (expectedType === 'ecdsa-p256') {
            if (details.type && details.type !== 'ec' && details.type !== 'ecdh') return null;
            if (details.namedCurve && details.namedCurve !== 'P-256') return null;
        }
        return keyObject;
    } catch (err) {
        console.log("Key validation failed:", err.message);
        return null;
    }
}

function processQueue() {
    if (activeTasks >= MAX_CONCURRENT_TASKS || taskQueue.length === 0) return;
    const task = taskQueue.shift();
    activeTasks++;
    task.run()
        .then(result => task.resolve(result))
        .catch(err => task.reject(err))
        .finally(() => {
            activeTasks--;
            processQueue();
        });
}

function enqueueTask(runner) {
    return new Promise((resolve, reject) => {
        taskQueue.push({ run: runner, resolve, reject });
        processQueue();
    });
}

setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, session] of sessions.entries()) {
        if (now - session.lastActive > SESSION_TIMEOUT) {
            sessions.delete(id);
            cleaned++;
        }
    }
    if (cleaned > 0) console.log(`[Cleaner] Removed ${cleaned} expired sessions.`);
}, CLEANUP_INTERVAL);

// ✅ 修复版：使用 node-forge 手动生成 CSR (强制 SHA-256)
function generateCsrManual(domains, privateKeyPem, keyType) {
    return new Promise((resolve, reject) => {
        if (!forge) {
            return reject(new Error("Node v24 requires 'node-forge'. Please run: npm install node-forge"));
        }

        try {
            const pki = forge.pki;
            const privateKey = pki.privateKeyFromPem(privateKeyPem);
            const csr = pki.createCertificationRequest();

            // ✅ 修复变量冲突：先声明，后赋值
            let pubKeyPem;
            let publicKeyObj;

            if (keyType.startsWith('rsa')) {
                // RSA: 尝试导出为 PKCS#1 公钥
                const keyObj = crypto.createPrivateKey(privateKeyPem);
                const pubKeyObjCrypto = crypto.createPublicKey(keyObj);
                // 注意：RSA 公钥可以用 pkcs1 或 spki，forge 通常都能处理，pkcs1 更传统
                pubKeyPem = pubKeyObjCrypto.export({ type: 'pkcs1', format: 'pem' }).toString();
            } else {
                // EC: 必须使用 SPKI 格式
                const keyObj = crypto.createPrivateKey(privateKeyPem);
                const pubKeyObjCrypto = crypto.createPublicKey(keyObj);
                pubKeyPem = pubKeyObjCrypto.export({ type: 'spki', format: 'pem' }).toString();
            }

            // 解析公钥 PEM 为 forge 对象
            publicKeyObj = pki.publicKeyFromPem(pubKeyPem);
            csr.publicKey = publicKeyObj;

            // 设置属性
            const attrs = [{
                name: 'commonName',
                value: domains[0]
            }];

            if (domains.length > 1) {
                attrs.push({
                    name: 'subjectAltName',
                    altNames: domains.slice(1).map(d => ({
                        type: 2, // DNS
                        value: d
                    }))
                });
            }
            csr.setSubject(attrs);

            // ✅ 关键：使用 SHA-256 签名
            csr.sign(privateKey, forge.md.sha256.create());

            const csrPem = pki.certificationRequestToPem(csr);
            resolve(csrPem);
        } catch (err) {
            reject(err);
        }
    });
}

app.post('/api/create-session', async (req, res) => {
    const { emails, domains, mode, envType, keyType, isRenewal, oldPrivateKey } = req.body;

    if (!emails) return res.status(400).json({ error: '邮箱不能为空' });
    const cleanEmails = emails.split(',').map(e => e.trim()).filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
    if (cleanEmails.length === 0) return res.status(400).json({ error: '邮箱格式无效' });

    if (!domains || domains.length === 0) return res.status(400).json({ error: '至少需要一个域名' });
    if (domains.length > 100) return res.status(400).json({ error: '最多支持 100 个域名' });

    const cleanDomains = domains.map(d => d.trim().toLowerCase()).filter(d => d);
    for (const d of cleanDomains) {
        if (!validateDomain(d)) return res.status(400).json({ error: `域名格式无效: ${d}` });
    }

    const hasWildcard = cleanDomains.some(d => d.startsWith('*.'));
    if (hasWildcard && mode !== 'dns-01') {
        return res.status(400).json({ error: '泛域名必须使用 DNS-01 验证' });
    }

    const allowedKeys = ['rsa-2048', 'rsa-3072', 'ecdsa-p256'];
    if (!allowedKeys.includes(keyType)) return res.status(400).json({ error: '不支持的密钥类型' });

    const sessionId = createSessionId();
    const isStaging = envType === 'staging';

    const session = {
        id: sessionId,
        config: { domains: cleanDomains, emails: cleanEmails, mode, envType, keyType, isRenewal: !!isRenewal },
        status: 'queueing',
        lastActive: Date.now(),
        logs: [],
        client: null,
        privateKeyObject: null,
        csr: null,
        order: null,
        challengeData: null,
        certificate: null
    };

    sessions.set(sessionId, session);
    log(session, 'info', '请求已接收', '正在排队等待处理...');

    res.json({ success: true, sessionId, message: '请求已加入队列，请查看日志进度' });

    enqueueTask(async () => {
        try {
            session.status = 'processing';
            log(session, 'step', '开始处理 (队列就绪)', '连接 ACME 服务器...');

            const directoryUrl = isStaging ? acme.directory.letsencrypt.staging : acme.directory.letsencrypt.production;

            session.client = new acme.Client({
                directoryUrl,
                accountKey: await acme.crypto.createPrivateKey()
            });
            log(session, 'step', 'ACME 客户端已连接', '注册账户...');

            await session.client.createAccount({
                termsOfServiceAgreed: true,
                contact: cleanEmails.map(e => `mailto:${e}`)
            });
            log(session, 'success', '账户注册成功', '处理密钥...');

            let keyObj = null;
            let privateKeyPem = null;

            // 1. 处理续期
            if (isRenewal && oldPrivateKey) {
                const cleanInput = (typeof oldPrivateKey === 'string') ? oldPrivateKey.trim() : "";
                const looksLikeKey = cleanInput.length > 50 && cleanInput.includes('PRIVATE KEY') && cleanInput.startsWith('-----BEGIN');

                if (looksLikeKey) {
                    log(session, 'step', '检测到有效的旧私钥', '验证并加载...');
                    keyObj = getValidatedKeyObject(cleanInput, keyType);
                    if (keyObj) {
                        privateKeyPem = keyObj.export({ format: 'pem', type: 'pkcs8' });
                        log(session, 'success', '旧私钥加载成功', '将复用此密钥');
                    } else {
                        log(session, 'warn', '旧私钥验证失败', '将生成新密钥');
                    }
                } else {
                    if (cleanInput.length > 0) log(session, 'info', '续期框内容无效', '忽略并生成新密钥');
                    else log(session, 'info', '续期模式但未提供旧私钥', '生成全新密钥对');
                }
            }

            // 2. 生成新私钥
            if (!keyObj) {
                try {
                    let generatedPair;
                    if (keyType === 'rsa-2048') {
                        generatedPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
                    } else if (keyType === 'rsa-3072') {
                        generatedPair = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
                    } else if (keyType === 'ecdsa-p256') {
                        generatedPair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
                    } else {
                        throw new Error('未知的密钥类型');
                    }
                    keyObj = generatedPair.privateKey;
                    privateKeyPem = keyObj.export({ format: 'pem', type: 'pkcs8' });
                    log(session, 'info', `已生成新密钥 (${keyType})`, '生成 CSR...');
                } catch (genErr) {
                    throw new Error(`密钥生成失败: ${genErr.message}`);
                }
            }

            session.privateKeyObject = keyObj;

            // 3. 生成 CSR (Node v24 专用路径)
            let csr;
            if (forge) {
                log(session, 'step', '使用 node-forge (SHA-256) 生成 CSR...', '兼容 OpenSSL 3');
                try {
                    csr = await generateCsrManual(cleanDomains, privateKeyPem, keyType);
                } catch (forgeErr) {
                    log(session, 'warn', 'node-forge 生成失败，尝试 acme-client 默认方法', forgeErr.message);
                    // Fallback
                    const details = keyObj.asymmetricKeyDetails || {};
                    const exportOpts = details.type === 'rsa' ? { type: 'pkcs1', format: 'pem' } : { type: 'sec1', format: 'pem' };
                    const fallbackPem = keyObj.export(exportOpts);
                    csr = await acme.crypto.createCsr({ commonName: cleanDomains[0], altNames: cleanDomains.slice(1) }, fallbackPem);
                }
            } else {
                log(session, 'warn', '未找到 node-forge，使用 acme-client 默认方法 (风险较高)');
                const details = keyObj.asymmetricKeyDetails || {};
                const exportOpts = details.type === 'rsa' ? { type: 'pkcs1', format: 'pem' } : { type: 'sec1', format: 'pem' };
                const pemStr = keyObj.export(exportOpts);
                csr = await acme.crypto.createCsr({ commonName: cleanDomains[0], altNames: cleanDomains.slice(1) }, pemStr);
            }

            session.csr = csr;
            log(session, 'step', 'CSR 生成完毕', '提交订单...');

            const identifiers = cleanDomains.map(d => ({ type: 'dns', value: d }));
            session.order = await session.client.createOrder({ identifiers });
            log(session, 'step', '订单已创建', '获取授权挑战...');

            const authorizations = await session.client.getAuthorizations(session.order);
            if (!authorizations.length) throw new Error('未获取到授权信息');

            const challengesToSolve = [];
            for (const auth of authorizations) {
                const domain = auth.identifier.value;
                let challenge = null;
                if (mode === 'http-01') challenge = auth.challenges.find(c => c.type === 'http-01');
                else challenge = auth.challenges.find(c => c.type === 'dns-01');

                if (!challenge) throw new Error(`域名 ${domain} 找不到 ${mode} 挑战`);

                const keyAuth = await session.client.getChallengeKeyAuthorization(challenge);

                challengesToSolve.push({
                    domain, type: mode, token: challenge.token, keyAuthorization: keyAuth,
                    challengeObj: challenge, authorizationObj: auth,
                    display: mode === 'http-01' ? {
                        url: `http://${domain}/.well-known/acme-challenge/${challenge.token}`,
                        content: keyAuth
                    } : {
                        recordName: `_acme-challenge.${domain}`,
                        recordValue: keyAuth
                    }
                });
            }

            session.challengeData = challengesToSolve;
            session.status = 'waiting_user';
            log(session, 'step', '挑战数据已就绪', `请配置 ${challengesToSolve.length} 个验证记录。`);

        } catch (err) {
            session.status = 'failed';
            log(session, 'error', `初始化失败: ${err.message}`, '请重试', err.stack);
        }
    }).catch(err => {
        session.status = 'failed';
        log(session, 'error', `系统繁忙: ${err.message}`, '请稍后重试');
    });
});

app.post('/api/verify', async (req, res) => {
    const { sessionId } = req.body;
    const session = sessions.get(sessionId);
    if (!session) return res.status(404).json({ error: '会话不存在' });
    if (session.status !== 'waiting_user') return res.status(400).json({ error: `当前状态不可验证: ${session.status}` });

    session.lastActive = Date.now();
    log(session, 'info', '验证请求已接收', '加入验证队列...');

    enqueueTask(async () => {
        try {
            log(session, 'step', '开始验证流程', '提交挑战...');
            const challenges = session.challengeData;
            for (const item of challenges) {
                log(session, 'step', `提交 ${item.domain} 挑战`, '等待 LE 响应...');
                await session.client.completeChallenge(item.challengeObj);
            }
            log(session, 'info', '所有挑战已提交', '轮询状态...');
            const freshAuthorizations = await session.client.getAuthorizations(session.order);
            const authMap = new Map();
            freshAuthorizations.forEach(auth => authMap.set(auth.identifier.value, auth));
            for (const item of challenges) {
                const auth = authMap.get(item.domain);
                if (!auth) throw new Error(`找不到 ${item.domain} 的授权`);
                log(session, 'step', `等待 ${item.domain} 验证`, '轮询中...');
                await session.client.waitForValidStatus(auth, 90000);
                log(session, 'success', `${item.domain} 验证通过`, '继续...');
            }
            log(session, 'success', '所有验证通过！', '签发证书...');
            const finalized = await session.client.finalizeOrder(session.order, session.csr, 60000);
            const cert = await session.client.getCertificate(finalized);
            session.certificate = cert;
            session.status = 'completed';
            log(session, 'success', '证书签发成功！', '可查看或下载');
        } catch (err) {
            let errMsg = err.message;
            if (errMsg.includes('Timeout')) errMsg = '验证超时。';
            if (errMsg.includes('invalid') || errMsg.includes('CSR')) errMsg = '验证失败或 CSR 错误。请确保已安装 node-forge (npm install node-forge)。';
            log(session, 'error', `验证出错: ${errMsg}`, '修正后可重试');
        }
    });
    res.json({ success: true, message: '验证任务已加入队列' });
});

app.get('/api/session/:id', (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'Not found' });
    let pemKey = null;
    if (s.privateKeyObject) {
        try { pemKey = s.privateKeyObject.export({ format: 'pem', type: 'pkcs8' }); }
        catch (e) { try { pemKey = s.privateKeyObject.export({ format: 'pem' }); } catch (e2) { pemKey = "Error"; } }
    }
    res.json({ status: s.status, logs: s.logs, config: s.config, hasCert: !!s.certificate, certificate: s.certificate, privateKey: pemKey, challenges: s.challengeData });
});

app.get('/download/cert/:id', (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s || !s.certificate) return res.status(404).send('Not Found');
    res.setHeader('Content-Type', 'application/x-x509-ca-cert');
    res.setHeader('Content-Disposition', `attachment; filename="${s.config.domains[0].replace(/[^a-z0-9]/gi, '_')}.crt"`);
    res.send(s.certificate);
});

app.get('/download/key/:id', (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s || !s.privateKeyObject) return res.status(404).send('Not Found');
    let pemKey;
    try { pemKey = s.privateKeyObject.export({ format: 'pem', type: 'pkcs8' }); }
    catch (e) { pemKey = s.privateKeyObject.export({ format: 'pem' }); }
    res.setHeader('Content-Type', 'application/x-pem-file');
    res.setHeader('Content-Disposition', `attachment; filename="${s.config.domains[0].replace(/[^a-z0-9]/gi, '_')}.key"`);
    res.send(pemKey);
});

app.listen(PORT, () => {
    console.log(`🔒 Production LE Tool Running on ${PORT}`);
    console.log(`✅ Fixed: Variable redeclaration error in CSR generation`);
    if (!forge) console.log(`⚠️  WARNING: node-forge not found.`);
    else console.log(`✅ node-forge loaded successfully.`);
});