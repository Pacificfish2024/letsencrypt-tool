const express = require('express');
const acme = require('acme-client');
const crypto = require('crypto');
const serverless = require('serverless-http');

// ================= 环境适配：仅在非ESA环境加载fs/path =================
let fs, path;
let forge;

// 运行时检测 - 优先识别阿里云ESA
const RUNTIME = {
    LOCAL: 'local',
    ALIYUN_ESA: 'aliyun_esa',
    TENCENT_EO: 'tencent_eo',
    CLOUDFLARE: 'cloudflare',
    GITHUB: 'github'
};

function detectRuntime() {
    // 1. 阿里云ESA优先检测
    if (typeof globalThis !== 'undefined' && globalThis.__ESA__) {
        return RUNTIME.ALIYUN_ESA;
    }
    // 2. Cloudflare Workers
    if (
        typeof globalThis !== 'undefined' &&
        globalThis.caches &&
        globalThis.fetch &&
        !globalThis.process
    ) {
        return RUNTIME.CLOUDFLARE;
    }
    // 3. 腾讯云EdgeOne
    if (process.env.TENCENTCLOUD_RUNENV === 'EdgeOne') {
        return RUNTIME.TENCENT_EO;
    }
    // 4. GitHub Actions
    if (process.env.GITHUB_ACTIONS) {
        return RUNTIME.GITHUB;
    }
    // 兜底：本地环境
    return RUNTIME.LOCAL;
}

const currentRuntime = detectRuntime();
const isLocal = currentRuntime === RUNTIME.LOCAL;
const isAliyunESA = currentRuntime === RUNTIME.ALIYUN_ESA;

// 仅在非ESA环境加载fs/path（解决构建报错）
if (!isAliyunESA) {
    try {
        fs = require('fs').promises;
        path = require('path');
    } catch (e) {
        console.warn("⚠️ fs/path模块加载失败，仅影响本地KV文件存储");
    }
}

// 加载node-forge（兼容Node v24+）
try {
    forge = require('node-forge');
} catch (e) {
    console.warn("⚠️ 未找到 node-forge，CSR 生成可能在 Node v24+ 环境中失败，执行 npm install node-forge 可修复");
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '2mb' }));

// ================= 静态文件托管：仅本地环境启用 =================
if (isLocal) {
    app.use(express.static('public'));
}

// ================= KV存储类（适配ESA环境，禁用文件系统） =================
class BaseKV {
    async init() { }
    async get(key) { return null; }
    async put(key, value, ttl = null) { return true; }
    async delete(key) { return true; }
    async list(prefix = '') { return []; }

    serialize(value, ttl = null) {
        return JSON.stringify({
            value,
            expireAt: ttl ? Date.now() + ttl : null,
            updatedAt: Date.now()
        });
    }

    deserialize(raw) {
        if (!raw) return null;
        try {
            const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (data.expireAt && Date.now() > data.expireAt) return null;
            return data.value;
        } catch { return null; }
    }
}

// 原生KV（内存+文件，ESA环境强制内存）
class NativeKV extends BaseKV {
    constructor() {
        super();
        this.memoryStore = new Map();
        this.filePath = isLocal && path ? path.join(__dirname, 'data', 'acme-kv-store.json') : '';
        // ESA环境强制使用内存存储
        this.useFile = !isLocal && !isAliyunESA && fs && path;
    }

    async init() {
        if (this.useFile) {
            try {
                const dir = path.dirname(this.filePath);
                await fs.access(dir);
            } catch {
                await fs.mkdir(dir, { recursive: true });
            }
            try {
                await fs.access(this.filePath);
            } catch {
                await fs.writeFile(this.filePath, JSON.stringify({}), 'utf-8');
            }
        }
    }

    async _readFile() {
        const content = await fs.readFile(this.filePath, 'utf-8');
        return JSON.parse(content);
    }

    async _writeFile(data) {
        await fs.writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
    }

    async get(key) {
        if (!this.useFile) return this.deserialize(this.memoryStore.get(key));
        const store = await this._readFile();
        return this.deserialize(store[key]);
    }

    async put(key, value, ttl = null) {
        const data = this.serialize(value, ttl);
        if (!this.useFile) {
            this.memoryStore.set(key, data);
            return true;
        }
        const store = await this._readFile();
        store[key] = data;
        await this._writeFile(store);
        return true;
    }

    async delete(key) {
        if (!this.useFile) {
            this.memoryStore.delete(key);
            return true;
        }
        const store = await this._readFile();
        delete store[key];
        await this._writeFile(store);
        return true;
    }

    async list(prefix = '') {
        if (!this.useFile) return Array.from(this.memoryStore.keys()).filter(k => k.startsWith(prefix));
        const store = await this._readFile();
        return Object.keys(store).filter(k => k.startsWith(prefix));
    }
}

// Cloudflare KV
class CloudflareKV extends BaseKV {
    constructor() {
        super();
        this.kvBindingName = process.env.CF_KV_BINDING || 'ACME_KV';
        this.kv = globalThis[this.kvBindingName];
    }

    async init() {
        if (!this.kv) throw new Error(`Cloudflare KV 绑定 ${this.kvBindingName} 不存在，请在控制台预先绑定`);
    }

    async get(key) { return this.deserialize(await this.kv.get(key)); }
    async put(key, value, ttl = null) {
        await this.kv.put(key, this.serialize(value, ttl), ttl ? { expirationTtl: Math.floor(ttl / 1000) } : {});
        return true;
    }
    async delete(key) { await this.kv.delete(key); return true; }
    async list(prefix = '') {
        const res = await this.kv.list({ prefix });
        return res.keys.map(k => k.name);
    }
}

// 腾讯云EO KV
class TencentEOKV extends BaseKV {
    constructor() {
        super();
        this.config = {
            secretId: process.env.TENCENT_SECRET_ID,
            secretKey: process.env.TENCENT_SECRET_KEY,
            zoneId: process.env.TENCENT_ZONE_ID,
            namespace: process.env.TENCENT_KV_NAMESPACE || 'ssl',
            region: process.env.TENCENT_REGION || 'ap-guangzhou'
        };
    }

    async init() {
        if (!this.config.secretId || !this.config.secretKey || !this.config.zoneId) {
            throw new Error('腾讯云EO KV 配置缺失，请检查环境变量');
        }
        try {
            const { Client } = require('tencentcloud-sdk-nodejs-teo/TeoClient');
            this.client = new Client({
                credential: { secretId: this.config.secretId, secretKey: this.config.secretKey },
                region: this.config.region,
                profile: { httpProfile: { endpoint: 'teo.tencentcloudapi.com' } }
            });
        } catch (err) {
            throw new Error(`腾讯云EO SDK未安装，请执行 npm install tencentcloud-sdk-nodejs-teo，错误：${err.message}`);
        }
    }

    async get(key) {
        try {
            const res = await this.client.DescribeKv({
                ZoneId: this.config.zoneId,
                Namespace: this.config.namespace,
                Key: key
            });
            return this.deserialize(res.Value);
        } catch { return null; }
    }

    async put(key, value, ttl = null) {
        const params = {
            ZoneId: this.config.zoneId,
            Namespace: this.config.namespace,
            Key: key,
            Value: this.serialize(value, ttl)
        };
        if (ttl) params.ExpirationTtl = Math.floor(ttl / 1000);
        await this.client.ModifyKv(params);
        return true;
    }

    async delete(key) {
        await this.client.DeleteKv({
            ZoneId: this.config.zoneId,
            Namespace: this.config.namespace,
            Key: key
        });
        return true;
    }

    async list(prefix = '') {
        const res = await this.client.DescribeKvList({
            ZoneId: this.config.zoneId,
            Namespace: this.config.namespace,
            Filters: prefix ? [{ Key: 'Key', Value: prefix, Operator: 'prefix' }] : []
        });
        return res.KvList.map(k => k.Key);
    }
}

// 阿里云ESA KV
class AliyunESAKV extends BaseKV {
    constructor() {
        super();
        this.config = {
            accessKeyId: process.env.ALIYUN_ACCESS_KEY_ID,
            accessKeySecret: process.env.ALIYUN_ACCESS_KEY_SECRET,
            namespace: process.env.ALIYUN_KV_NAMESPACE || 'ssl',
            instanceId: process.env.ALIYUN_ESA_INSTANCE_ID
        };
    }

    async init() {
        // ESA边缘运行时内置KV
        if (typeof globalThis !== 'undefined' && globalThis.__KV__) {
            this.client = globalThis.__KV__;
            return;
        }
        // 本地开发/非边缘环境使用SDK
        if (!this.config.accessKeyId || !this.config.accessKeySecret || !this.config.instanceId) {
            throw new Error('阿里云ESA KV 配置缺失，请检查环境变量');
        }
        try {
            const ESAClient = require('@alicloud/esa-kv-sdk');
            this.client = new ESAClient(this.config);
        } catch (err) {
            throw new Error(`阿里云ESA SDK未安装，请执行 npm install @alicloud/esa-kv-sdk，错误：${err.message}`);
        }
    }

    async get(key) {
        try {
            return this.deserialize(await this.client.get(key));
        } catch { return null; }
    }

    async put(key, value, ttl = null) {
        await this.client.put(key, this.serialize(value, ttl), ttl ? { ttl: Math.floor(ttl / 1000) } : {});
        return true;
    }

    async delete(key) {
        await this.client.delete(key);
        return true;
    }

    async list(prefix = '') {
        const res = await this.client.list({ prefix });
        return res.keys || [];
    }
}

// GitHub Gist KV
class GithubGistKV extends BaseKV {
    constructor() {
        super();
        this.config = {
            token: process.env.GITHUB_TOKEN,
            gistId: process.env.GITHUB_GIST_ID,
            fileName: process.env.GITHUB_GIST_FILE || 'acme-kv-store.json'
        };
        this.cache = {};
        this.lastSync = 0;
        this.syncInterval = 5000;
    }

    async init() {
        if (!this.config.token) throw new Error('GitHub Token 未配置，请设置GITHUB_TOKEN环境变量');
        try {
            const { Octokit } = require('@octokit/rest');
            this.octokit = new Octokit({ auth: this.config.token });
        } catch (err) {
            throw new Error(`GitHub SDK未安装，请执行 npm install @octokit/rest，错误：${err.message}`);
        }

        if (this.config.gistId) {
            const { data } = await this.octokit.gists.get({ gist_id: this.config.gistId });
            this.cache = this.deserialize(data.files[this.config.fileName]?.content) || {};
        } else {
            const { data } = await this.octokit.gists.create({
                description: 'ACME KV Store',
                public: false,
                files: { [this.config.fileName]: { content: this.serialize({}) } }
            });
            this.config.gistId = data.id;
            console.log(`[KV] 自动创建GitHub Gist成功，ID: ${this.config.gistId}`);
        }
    }

    async _sync() {
        if (Date.now() - this.lastSync < this.syncInterval) return;
        await this.octokit.gists.update({
            gist_id: this.config.gistId,
            files: { [this.config.fileName]: { content: this.serialize(this.cache) } }
        });
        this.lastSync = Date.now();
    }

    async get(key) {
        const data = this.cache[key];
        if (data?.expireAt && Date.now() > data.expireAt) {
            delete this.cache[key];
            return null;
        }
        return data?.value || null;
    }

    async put(key, value, ttl = null) {
        this.cache[key] = {
            value,
            expireAt: ttl ? Date.now() + ttl : null,
            updatedAt: Date.now()
        };
        await this._sync();
        return true;
    }

    async delete(key) {
        delete this.cache[key];
        await this._sync();
        return true;
    }

    async list(prefix = '') {
        return Object.keys(this.cache).filter(k => k.startsWith(prefix));
    }
}

// KV工厂类
const kvMap = {
    [RUNTIME.CLOUDFLARE]: CloudflareKV,
    [RUNTIME.ALIYUN_ESA]: AliyunESAKV,
    [RUNTIME.TENCENT_EO]: TencentEOKV,
    [RUNTIME.GITHUB]: GithubGistKV,
    [RUNTIME.LOCAL]: NativeKV
};

let kvInstance = null;
async function getKV() {
    if (kvInstance) return kvInstance;
    try {
        const KVClass = kvMap[currentRuntime] || NativeKV;
        kvInstance = new KVClass();
        await kvInstance.init();
        console.log(`[KV] 当前运行环境: ${currentRuntime}，使用KV存储: ${KVClass.name}`);
    } catch (err) {
        console.warn(`[KV] ${currentRuntime} KV初始化失败，降级到原生存储: ${err.message}`);
        kvInstance = new NativeKV();
        await kvInstance.init();
    }
    return kvInstance;
}

// ================= 工具函数 =================
// KV操作重试
async function kvOperationWithRetry(operation, maxRetries = 3, delayMs = 1000) {
    let lastError;
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await operation();
        } catch (err) {
            lastError = err;
            console.warn(`[KV重试] 操作失败 (${i + 1}/${maxRetries}):`, err.message);
            if (i < maxRetries - 1) {
                await new Promise(resolve => setTimeout(resolve, delayMs * (i + 1)));
            }
        }
    }
    throw lastError;
}

// 会话安全获取
async function getSessionSafe(kv, sessionId, logFallback = null) {
    try {
        let session = await kvOperationWithRetry(() => kv.get(sessionId));
        if (!session && logFallback) {
            session = logFallback;
        }
        return session;
    } catch (err) {
        console.warn(`[会话获取] 重试后仍失败:`, err.message);
        return logFallback || null;
    }
}

// 阶段枚举
const STAGE = {
    INIT: 'init',
    KEY_GEN: 'key_gen',
    ACCOUNT_REG: 'account_reg',
    ORDER_CREATE: 'order_create',
    CHALLENGE_PREPARE: 'challenge_prepare',
    WAITING_USER: 'waiting_user',
    VERIFYING: 'verifying',
    ISSUING: 'issuing',
    COMPLETED: 'completed',
    FAILED: 'failed'
};

// 核心配置
const SESSION_TIMEOUT = 90 * 60 * 1000;
const CLEANUP_INTERVAL = 5 * 60 * 1000;
const MAX_CONCURRENT_TASKS = 5;

let activeTasks = 0;
const taskQueue = [];

// 工具函数
function createSessionId() {
    return `sess_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

async function log(sessionId, type, current, next = null, details = null) {
    try {
        const kv = await getKV();
        let session = await kvOperationWithRetry(() => kv.get(sessionId));
        if (!session) {
            console.log(`[日志警告] 会话 ${sessionId} 不存在，跳过日志记录`);
            return null;
        }

        const entry = { ts: new Date().toISOString(), type, current, next, details };
        session.logs.push(entry);
        if (session.logs.length > 200) session.logs.shift();
        session.lastActive = Date.now();

        await kvOperationWithRetry(() => kv.put(sessionId, session));
        return session;
    } catch (err) {
        console.error(`[日志错误] 会话 ${sessionId}:`, err.message);
        try {
            const kv = await getKV();
            return await kv.get(sessionId);
        } catch {
            return null;
        }
    }
}

function simpleLog(sessionId, message) {
    console.log(`[${sessionId}] ${message}`);
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

// CSR生成函数
function generateCsrManual(domains, privateKeyPem, keyType) {
    return new Promise((resolve, reject) => {
        if (!forge) {
            return reject(new Error("Node v24+ 环境需要安装 node-forge，请执行: npm install node-forge"));
        }

        try {
            const pki = forge.pki;
            const privateKey = pki.privateKeyFromPem(privateKeyPem);
            const csr = pki.createCertificationRequest();

            let pubKeyPem;
            let publicKeyObj;

            if (keyType.startsWith('rsa')) {
                const keyObj = crypto.createPrivateKey(privateKeyPem);
                const pubKeyObjCrypto = crypto.createPublicKey(keyObj);
                pubKeyPem = pubKeyObjCrypto.export({ type: 'pkcs1', format: 'pem' }).toString();
            } else {
                const keyObj = crypto.createPrivateKey(privateKeyPem);
                const pubKeyObjCrypto = crypto.createPublicKey(keyObj);
                pubKeyPem = pubKeyObjCrypto.export({ type: 'spki', format: 'pem' }).toString();
            }

            publicKeyObj = pki.publicKeyFromPem(pubKeyPem);
            csr.publicKey = publicKeyObj;

            const attrs = [{ name: 'commonName', value: domains[0] }];
            if (domains.length > 1) {
                attrs.push({
                    name: 'subjectAltName',
                    altNames: domains.slice(1).map(d => ({ type: 2, value: d }))
                });
            }
            csr.setSubject(attrs);
            csr.sign(privateKey, forge.md.sha256.create());

            const csrPem = pki.certificationRequestToPem(csr);
            resolve(csrPem);
        } catch (err) {
            reject(err);
        }
    });
}

// ================= 核心业务函数 =================
// 完整ACME流程
async function runFullAcmeFlow(kv, sessionId, oldPrivateKey = null) {
    simpleLog(sessionId, '开始完整ACME流程');
    let sess = await getSessionSafe(kv, sessionId);
    if (!sess) throw new Error('会话不存在');

    const { emails, domains, mode, envType, keyType, isRenewal } = sess.config;
    const isStaging = envType === 'staging';
    const taskCleanEmails = emails;
    const taskCleanDomains = domains;

    // 1. 连接ACME服务器
    sess.stage = STAGE.KEY_GEN;
    sess.status = 'processing';
    await kv.put(sessionId, sess);
    sess = await log(sessionId, 'step', '开始处理 (队列就绪)', '连接 ACME 服务器...');
    if (!sess) {
        sess = await getSessionSafe(kv, sessionId);
        if (!sess) return;
    }

    const directoryUrl = isStaging ? acme.directory.letsencrypt.staging : acme.directory.letsencrypt.production;
    const accountKey = await acme.crypto.createPrivateKey();
    sess.accountKeyPem = accountKey.toString();
    await kv.put(sessionId, sess);

    // 2. 注册账户
    sess.stage = STAGE.ACCOUNT_REG;
    await kv.put(sessionId, sess);
    sess = await log(sessionId, 'step', 'ACME 客户端已连接', '注册账户...');
    if (!sess) {
        sess = await getSessionSafe(kv, sessionId);
        if (!sess) return;
    }

    const client = new acme.Client({ directoryUrl, accountKey });
    await client.createAccount({
        termsOfServiceAgreed: true,
        contact: taskCleanEmails.map(e => `mailto:${e}`)
    });
    sess = await log(sessionId, 'success', '账户注册成功', '处理密钥...');
    if (!sess) {
        sess = await getSessionSafe(kv, sessionId);
        if (!sess) return;
    }

    // 3. 生成/加载密钥
    sess.stage = STAGE.KEY_GEN;
    await kv.put(sessionId, sess);
    let keyObj = null;
    let privateKeyPem = null;

    if (isRenewal && oldPrivateKey) {
        const cleanInput = (typeof oldPrivateKey === 'string') ? oldPrivateKey.trim() : "";
        const looksLikeKey = cleanInput.length > 50 && cleanInput.includes('PRIVATE KEY') && cleanInput.startsWith('-----BEGIN');

        if (looksLikeKey) {
            sess = await log(sessionId, 'step', '检测到有效的旧私钥', '验证并加载...');
            if (!sess) {
                sess = await getSessionSafe(kv, sessionId);
                if (!sess) return;
            }
            keyObj = getValidatedKeyObject(cleanInput, keyType);
            if (keyObj) {
                privateKeyPem = keyObj.export({ format: 'pem', type: 'pkcs8' });
                sess = await log(sessionId, 'success', '旧私钥加载成功', '将复用此密钥');
                if (!sess) {
                    sess = await getSessionSafe(kv, sessionId);
                    if (!sess) return;
                }
            } else {
                sess = await log(sessionId, 'warn', '旧私钥验证失败', '将生成新密钥');
                if (!sess) {
                    sess = await getSessionSafe(kv, sessionId);
                    if (!sess) return;
                }
            }
        }
    }

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
            sess = await log(sessionId, 'info', `已生成新密钥 (${keyType})`, '生成 CSR...');
            if (!sess) {
                sess = await getSessionSafe(kv, sessionId);
                if (!sess) return;
            }
        } catch (genErr) {
            throw new Error(`密钥生成失败: ${genErr.message}`);
        }
    }

    sess.privateKeyPem = privateKeyPem;
    await kv.put(sessionId, sess);

    // 4. 生成CSR
    let csr;
    if (forge) {
        sess = await log(sessionId, 'step', '使用 node-forge (SHA-256) 生成 CSR...', '兼容 OpenSSL 3');
        if (!sess) {
            sess = await getSessionSafe(kv, sessionId);
            if (!sess) return;
        }
        try {
            csr = await generateCsrManual(taskCleanDomains, privateKeyPem, keyType);
        } catch (forgeErr) {
            sess = await log(sessionId, 'warn', 'node-forge 生成失败，尝试 acme-client 默认方法', forgeErr.message);
            if (!sess) {
                sess = await getSessionSafe(kv, sessionId);
                if (!sess) return;
            }
            const details = keyObj.asymmetricKeyDetails || {};
            const exportOpts = details.type === 'rsa' ? { type: 'pkcs1', format: 'pem' } : { type: 'sec1', format: 'pem' };
            const fallbackPem = keyObj.export(exportOpts);
            csr = await acme.crypto.createCsr({ commonName: taskCleanDomains[0], altNames: taskCleanDomains.slice(1) }, fallbackPem);
        }
    } else {
        sess = await log(sessionId, 'warn', '未找到 node-forge，使用 acme-client 默认方法 (风险较高)');
        if (!sess) {
            sess = await getSessionSafe(kv, sessionId);
            if (!sess) return;
        }
        const details = keyObj.asymmetricKeyDetails || {};
        const exportOpts = details.type === 'rsa' ? { type: 'pkcs1', format: 'pem' } : { type: 'sec1', format: 'pem' };
        const pemStr = keyObj.export(exportOpts);
        csr = await acme.crypto.createCsr({ commonName: taskCleanDomains[0], altNames: taskCleanDomains.slice(1) }, pemStr);
    }

    sess.csr = csr;
    await kv.put(sessionId, sess);

    // 5. 创建订单
    sess.stage = STAGE.ORDER_CREATE;
    await kv.put(sessionId, sess);
    sess = await log(sessionId, 'step', 'CSR 生成完毕', '提交订单...');
    if (!sess) {
        sess = await getSessionSafe(kv, sessionId);
        if (!sess) return;
    }

    const identifiers = taskCleanDomains.map(d => ({ type: 'dns', value: d }));
    const order = await client.createOrder({ identifiers });
    sess.orderUrl = order.url;
    await kv.put(sessionId, sess);

    // 6. 准备挑战
    sess.stage = STAGE.CHALLENGE_PREPARE;
    await kv.put(sessionId, sess);
    sess = await log(sessionId, 'step', '订单已创建', '获取授权挑战...');
    if (!sess) {
        sess = await getSessionSafe(kv, sessionId);
        if (!sess) return;
    }

    const authorizations = await client.getAuthorizations(order);
    if (!authorizations.length) throw new Error('未获取到授权信息');

    const challengesToSolve = [];
    for (const auth of authorizations) {
        const domain = auth.identifier.value;
        let challenge = null;
        if (mode === 'http-01') challenge = auth.challenges.find(c => c.type === 'http-01');
        else challenge = auth.challenges.find(c => c.type === 'dns-01');

        if (!challenge) throw new Error(`域名 ${domain} 找不到 ${mode} 挑战`);

        const keyAuth = await client.getChallengeKeyAuthorization(challenge);
        challengesToSolve.push({
            domain,
            type: mode,
            token: challenge.token,
            keyAuthorization: keyAuth,
            challengeUrl: challenge.url,
            authorizationUrl: auth.url,
            display: mode === 'http-01' ? {
                url: `http://${domain}/.well-known/acme-challenge/${challenge.token}`,
                content: keyAuth
            } : {
                recordName: `_acme-challenge.${domain}`,
                recordValue: keyAuth
            }
        });
    }

    sess.challengeData = challengesToSolve;
    sess.stage = STAGE.WAITING_USER;
    sess.status = 'waiting_user';
    await kv.put(sessionId, sess);
    await log(sessionId, 'step', '挑战数据已就绪', `请配置 ${challengesToSolve.length} 个验证记录。`);
    simpleLog(sessionId, '完整ACME流程完成，等待用户验证');
}

// 验证流程
async function runVerificationFlow(kv, sessionId) {
    simpleLog(sessionId, '开始验证流程');
    let sess = await getSessionSafe(kv, sessionId);
    if (!sess) throw new Error('会话不存在');

    // 检查必要数据
    if (!sess.config || !sess.challengeData || !sess.accountKeyPem || !sess.orderUrl) {
        throw new Error('会话数据不完整，请重新申请');
    }

    sess.stage = STAGE.VERIFYING;
    sess.status = 'processing';
    await kv.put(sessionId, sess);
    sess = await log(sessionId, 'step', '开始验证流程', '重建ACME客户端...');
    if (!sess) {
        sess = await getSessionSafe(kv, sessionId);
        if (!sess) return;
    }

    const isStaging = sess.config.envType === 'staging';
    const directoryUrl = isStaging ? acme.directory.letsencrypt.staging : acme.directory.letsencrypt.production;
    const client = new acme.Client({ directoryUrl, accountKey: sess.accountKeyPem });
    const order = await client.getOrder({ url: sess.orderUrl });
    const challenges = sess.challengeData;

    sess = await log(sessionId, 'step', 'ACME客户端重建成功', '提交挑战...');
    if (!sess) {
        sess = await getSessionSafe(kv, sessionId);
        if (!sess) return;
    }

    // 提交挑战
    for (const item of challenges) {
        sess = await log(sessionId, 'step', `提交 ${item.domain} 挑战`, '等待 LE 响应...');
        if (!sess) {
            sess = await getSessionSafe(kv, sessionId);
            if (!sess) return;
        }

        try {
            const challenge = await client.getChallenge({ url: item.challengeUrl });
            if (challenge.status !== 'valid') {
                await client.completeChallenge(challenge);
            } else {
                await log(sessionId, 'info', `${item.domain} 挑战已验证`, '跳过重复提交');
            }
        } catch (challengeErr) {
            await log(sessionId, 'warn', `${item.domain} 挑战获取异常`, '尝试继续...', challengeErr.message);
        }
    }

    sess = await log(sessionId, 'info', '所有挑战已提交', '轮询状态...');
    if (!sess) {
        sess = await getSessionSafe(kv, sessionId);
        if (!sess) return;
    }

    // 轮询验证状态
    const freshAuthorizations = await client.getAuthorizations(order);
    const authMap = new Map();
    freshAuthorizations.forEach(auth => authMap.set(auth.identifier.value, auth));

    for (const item of challenges) {
        const auth = authMap.get(item.domain);
        if (!auth) {
            await log(sessionId, 'warn', `找不到 ${item.domain} 的授权信息`, '尝试继续...');
            continue;
        }

        sess = await log(sessionId, 'step', `等待 ${item.domain} 验证`, '轮询中...');
        if (!sess) {
            sess = await getSessionSafe(kv, sessionId);
            if (!sess) return;
        }

        if (auth.status === 'valid') {
            await log(sessionId, 'success', `${item.domain} 已验证通过`, '继续...');
            continue;
        }

        await client.waitForValidStatus(auth, 90000);
        sess = await log(sessionId, 'success', `${item.domain} 验证通过`, '继续...');
        if (!sess) {
            sess = await getSessionSafe(kv, sessionId);
            if (!sess) return;
        }
    }

    // 签发证书
    sess.stage = STAGE.ISSUING;
    await kv.put(sessionId, sess);
    sess = await log(sessionId, 'success', '所有验证通过！', '签发证书...');
    if (!sess) {
        sess = await getSessionSafe(kv, sessionId);
        if (!sess) return;
    }

    let finalizedOrder;
    try {
        const currentOrder = await client.getOrder({ url: sess.orderUrl });
        if (currentOrder.status === 'ready') {
            finalizedOrder = await client.finalizeOrder(currentOrder, sess.csr, 60000);
        } else if (currentOrder.status === 'processing' || currentOrder.status === 'valid') {
            finalizedOrder = currentOrder;
        } else {
            throw new Error(`订单状态异常: ${currentOrder.status}`);
        }
    } catch (finalizeErr) {
        await log(sessionId, 'warn', '订单提交异常，尝试直接获取证书...', finalizeErr.message);
        finalizedOrder = await client.getOrder({ url: sess.orderUrl });
    }

    const cert = await client.getCertificate(finalizedOrder);
    if (!cert) throw new Error('证书获取失败，请稍后重试');

    sess = await getSessionSafe(kv, sessionId);
    if (!sess) return;

    sess.certificate = cert;
    sess.stage = STAGE.COMPLETED;
    sess.status = 'completed';
    await kv.put(sessionId, sess);
    await log(sessionId, 'success', '证书签发成功！', '可查看或下载');
    simpleLog(sessionId, '验证流程完成，证书已签发');
}

// ================= 会话清理 =================
if (isLocal) {
    setInterval(async () => {
        const kv = await getKV();
        const now = Date.now();
        let cleaned = 0;
        const sessionKeys = await kv.list('sess_');

        for (const key of sessionKeys) {
            const session = await kv.get(key);
            if (!session) continue;

            let shouldClean = false;
            if (session.status === 'completed') {
                shouldClean = now - session.lastActive > 7 * 24 * 60 * 60 * 1000;
            } else {
                shouldClean = now - session.lastActive > SESSION_TIMEOUT;
            }

            if (shouldClean) {
                await kv.delete(key);
                cleaned++;
            }
        }
        if (cleaned > 0) console.log(`[清理任务] 移除 ${cleaned} 个过期会话`);
    }, CLEANUP_INTERVAL);
}

// ================= API路由 =================
// 创建会话
app.post('/api/create-session', async (req, res) => {
    const kv = await getKV();
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
    const session = {
        id: sessionId,
        config: { domains: cleanDomains, emails: cleanEmails, mode, envType, keyType, isRenewal: !!isRenewal },
        status: 'queueing',
        stage: STAGE.INIT,
        lastActive: Date.now(),
        logs: [],
        accountKeyPem: null,
        privateKeyPem: null,
        csr: null,
        orderUrl: null,
        challengeData: null,
        certificate: null,
        oldPrivateKeyTemp: isRenewal ? oldPrivateKey : null
    };

    await kv.put(sessionId, session);
    await log(sessionId, 'info', '请求已接收', '正在排队等待处理...');

    res.json({ success: true, sessionId, message: '请求已加入队列，请查看日志进度' });

    // 后台执行完整流程
    enqueueTask(async () => {
        try {
            await runFullAcmeFlow(kv, sessionId, oldPrivateKey);
        } catch (err) {
            console.error(`[任务失败] 会话 ${sessionId}:`, err.message);
            let sess = await getSessionSafe(kv, sessionId);
            if (sess) {
                sess.status = 'failed';
                sess.stage = STAGE.FAILED;
                await kv.put(sessionId, sess);
                await log(sessionId, 'error', `初始化失败: ${err.message}`, '请点击重新验证重试', err.stack);
            }
        }
    }).catch(async (err) => {
        console.error(`[任务异常] 会话 ${sessionId}:`, err.message);
        let sess = await getSessionSafe(kv, sessionId);
        if (sess) {
            sess.status = 'failed';
            sess.stage = STAGE.FAILED;
            await kv.put(sessionId, sess);
            await log(sessionId, 'error', `系统繁忙: ${err.message}`, '请稍后重试');
        }
    });
});

// 验证接口
app.post('/api/verify', async (req, res) => {
    const kv = await getKV();
    const { sessionId } = req.body;
    const session = await getSessionSafe(kv, sessionId);
    if (!session) return res.status(404).json({ error: '会话不存在' });

    // 明确状态限制
    const allowedStatuses = ['waiting_user', 'failed'];
    if (!allowedStatuses.includes(session.status)) {
        return res.status(400).json({
            error: `当前状态不可验证: ${session.status}`,
            currentStatus: session.status,
            currentStage: session.stage,
            allowedStatuses: allowedStatuses,
            hint: '请等待处理完成或重新申请'
        });
    }

    // 判断失败阶段
    let action = '';
    let isFullRetry = false;

    if (session.status === 'failed') {
        const hasChallengeData = session.challengeData && session.challengeData.length > 0;
        const hasOrderUrl = !!session.orderUrl;
        const hasAccountKey = !!session.accountKeyPem;

        if (hasChallengeData && hasOrderUrl && hasAccountKey) {
            action = '继续验证流程';
            session.status = 'waiting_user';
            session.stage = STAGE.WAITING_USER;
        } else {
            action = '重新生成密钥并创建订单';
            isFullRetry = true;
            session.status = 'queueing';
            session.stage = STAGE.INIT;
            session.accountKeyPem = null;
            session.privateKeyPem = null;
            session.csr = null;
            session.orderUrl = null;
            session.challengeData = null;
            session.certificate = null;
        }
    } else {
        action = '开始验证';
    }

    session.lastActive = Date.now();
    await kv.put(sessionId, session);

    // 记录重新验证日志
    await log(sessionId, 'info', `点击重新验证`, action);
    res.json({
        success: true,
        message: `${action}，任务已加入队列`,
        isFullRetry: isFullRetry,
        action: action
    });

    // 后台执行对应流程
    enqueueTask(async () => {
        try {
            if (isFullRetry) {
                await log(sessionId, 'step', '检测到早期阶段失败', '重新开始完整流程...');
                await runFullAcmeFlow(kv, sessionId, session.oldPrivateKeyTemp);
            } else {
                await runVerificationFlow(kv, sessionId);
            }
        } catch (err) {
            console.error(`[验证任务失败] 会话 ${sessionId}:`, err.message);
            let sess = await getSessionSafe(kv, sessionId);
            if (sess) {
                let errMsg = err.message;
                if (errMsg.includes('Timeout')) errMsg = '验证超时，请检查DNS/HTTP记录配置后重试';
                if (errMsg.includes('invalid') || errMsg.includes('CSR')) errMsg = '验证失败或 CSR 错误。请确保已安装 node-forge (npm install node-forge)。';
                if (errMsg.includes('order') || errMsg.includes('数据不完整')) errMsg = '流程数据异常，请点击重新验证（将重新生成密钥和订单）';

                sess.status = 'failed';
                sess.stage = STAGE.FAILED;
                await kv.put(sessionId, sess);
                await log(sessionId, 'error', `验证出错: ${errMsg}`, '修正后可点击重新验证', err.stack);
            }
        }
    });
});

// 会话状态查询
app.get('/api/session-status/:id', async (req, res) => {
    const kv = await getKV();
    const s = await getSessionSafe(kv, req.params.id);
    if (!s) return res.status(404).json({ error: '会话不存在' });

    res.json({
        status: s.status,
        stage: s.stage,
        canRetry: s.status === 'failed' || s.status === 'waiting_user',
        canDownload: s.status === 'completed',
        lastActive: s.lastActive,
        message: getStatusMessage(s.status, s.stage),
        needsFullRetry: s.status === 'failed' && (!s.challengeData || !s.orderUrl || !s.accountKeyPem)
    });

    function getStatusMessage(status, stage) {
        if (status === 'failed') return '验证失败，请点击重新验证';
        if (stage === STAGE.KEY_GEN) return '正在生成密钥对...';
        if (stage === STAGE.ACCOUNT_REG) return '正在注册ACME账户...';
        if (stage === STAGE.ORDER_CREATE) return '正在创建证书订单...';
        if (stage === STAGE.CHALLENGE_PREPARE) return '正在准备验证挑战...';
        if (stage === STAGE.WAITING_USER) return '等待您配置验证记录...';
        if (stage === STAGE.VERIFYING) return '正在验证您的配置...';
        if (stage === STAGE.ISSUING) return '正在签发证书...';
        if (status === 'queueing') return '请求正在排队处理中...';
        if (status === 'processing') return '正在处理您的请求...';
        if (status === 'completed') return '证书签发成功！';
        return '未知状态';
    }
});

// 会话详情
app.get('/api/session/:id', async (req, res) => {
    const kv = await getKV();
    const s = await getSessionSafe(kv, req.params.id);
    if (!s) return res.status(404).json({ error: 'Not found' });

    res.json({
        status: s.status,
        stage: s.stage,
        logs: s.logs,
        config: s.config,
        hasCert: !!s.certificate,
        certificate: s.certificate,
        privateKey: s.privateKeyPem,
        challenges: s.challengeData
    });
});

// 下载证书
app.get('/api/download/cert/:id', async (req, res) => {
    const kv = await getKV();
    const s = await getSessionSafe(kv, req.params.id);
    if (!s || !s.certificate) return res.status(404).send('Not Found');
    res.setHeader('Content-Type', 'application/x-x509-ca-cert');
    res.setHeader('Content-Disposition', `attachment; filename="${s.config.domains[0].replace(/[^a-z0-9]/gi, '_')}.crt"`);
    res.send(s.certificate);
});

// 下载密钥
app.get('/api/download/key/:id', async (req, res) => {
    const kv = await getKV();
    const s = await getSessionSafe(kv, req.params.id);
    if (!s || !s.privateKeyPem) return res.status(404).send('Not Found');
    res.setHeader('Content-Type', 'application/x-pem-file');
    res.setHeader('Content-Disposition', `attachment; filename="${s.config.domains[0].replace(/[^a-z0-9]/gi, '_')}.key"`);
    res.send(s.privateKeyPem);
});

// 404兜底
app.use((req, res) => {
    console.log(`404 - ${req.method} ${req.originalUrl} - 运行环境: ${currentRuntime}`);
    res.status(404).json({
        error: 'API路径不存在',
        path: req.originalUrl,
        runtime: currentRuntime
    });
});

// ================= 全平台入口 =================
// 本地环境
if (isLocal) {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🔒 ACME证书工具已启动，本地访问地址: http://0.0.0.0:${PORT}`);
        console.log(`✅ 当前运行环境: ${currentRuntime}`);
        if (!forge) console.log(`⚠️  警告: node-forge 未安装，Node v24+ 环境可能出现CSR生成失败`);
        else console.log(`✅ node-forge 加载成功`);
    });
}

// 阿里云/腾讯云 handler
const handler = serverless(app, {
    provider: currentRuntime === RUNTIME.ALIYUN_ESA ? 'aliyun' : currentRuntime === RUNTIME.TENCENT_EO ? 'tencent' : 'aws'
});
module.exports.handler = handler;

// Cloudflare Workers
if (currentRuntime === RUNTIME.CLOUDFLARE) {
    addEventListener('fetch', (event) => {
        event.respondWith(handler(event.request));
    });
}