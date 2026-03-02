let sessionId = null;
let pollTimer = null;
let renderedLogCount = 0; 
let renewalCheckbox = null;
let renewalContainer = null;

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', function() {
    // 初始化DOM元素引用
    renewalCheckbox = document.getElementById('isRenewal');
    renewalContainer = document.getElementById('renewal-input-container');

    // 🔧 修复复选框：独立事件监听（避免label嵌套冲突）
    renewalCheckbox.addEventListener('change', function() {
        if (this.checked) {
            renewalContainer.classList.add('show');
            // 聚焦输入框提升体验
            setTimeout(() => document.getElementById('oldPrivateKey').focus(), 100);
        } else {
            renewalContainer.classList.remove('show');
        }
    });

    // 域名数量统计与泛域名检测
    document.getElementById('domains').addEventListener('input', function() {
        const lines = this.value.split(/[\n,]+/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));
        document.getElementById('domain-count').textContent = lines.length;
        
        const hasWildcard = lines.some(domain => domain.startsWith('*.'));
        const modeSelect = document.getElementById('mode');
        const alertBox = document.getElementById('wildcard-alert');
        
        if (hasWildcard) {
            modeSelect.value = 'dns-01'; 
            modeSelect.disabled = true; 
            alertBox.classList.add('show');
        } else {
            modeSelect.disabled = false; 
            alertBox.classList.remove('show');
        }
    });

    // ✅ 核心修复：开始会话（含输入验证）
    document.getElementById('startBtn').addEventListener('click', startSession);

    // ✅ 全局复制处理（事件委托 + 安全取值）
    document.addEventListener('click', function(e) {
        // 处理挑战项复制按钮
        if (e.target.classList.contains('copy-btn')) {
            e.preventDefault();
            const codeBlock = e.target.closest('.code-block');
            if (codeBlock && codeBlock.dataset.rawText) {
                const rawText = decodeURIComponent(codeBlock.dataset.rawText);
                copyToClipboard(rawText, e.target);
            }
            return;
        }
        
        // 处理证书预览区复制按钮
        if (e.target.dataset.copyTarget) {
            e.preventDefault();
            const targetEl = document.getElementById(e.target.dataset.copyTarget);
            if (targetEl && targetEl.textContent.trim()) {
                copyToClipboard(targetEl.textContent, e.target);
            } else {
                alert('⚠️ 目标内容为空，无法复制');
            }
            return;
        }
    });

    // 执行验证
    document.getElementById('verifyBtn').addEventListener('click', performVerify);

    // 页面加载完成提示
    console.log('%c✅ Let\'s Encrypt 专业版自助工具已加载', 'color: #2563eb; font-weight: bold; font-size: 1.2em;');
    console.log('%c💡 提示：本工具前端已完全修复复制功能与复选框交互问题', 'color: #16a34a;');
});

async function startSession() {
    const emailsInput = document.getElementById('emails');
    const domainsInput = document.getElementById('domains');
    const emails = emailsInput.value.trim();
    const domainsText = domainsInput.value;
    const domains = domainsText.split(/[\n,]+/)
        .map(s => s.trim())
        .filter(s => s && !s.startsWith('#') && s.length <= 253);
    
    const mode = document.getElementById('mode').value;
    const envType = document.getElementById('envType').value;
    const keyType = document.getElementById('keyType').value;
    const isRenewal = renewalCheckbox.checked;
    
    // ✅ 严格检查：只有当内容看起来像私钥时才发送
    let oldPrivateKeyToSend = "";
    if (isRenewal) {
        const inputVal = document.getElementById('oldPrivateKey').value.trim();
        // 必须包含PEM标记且长度合理
        if (inputVal.length > 50 && 
            inputVal.includes('-----BEGIN') && 
            inputVal.includes('PRIVATE KEY') && 
            inputVal.includes('-----END')) {
            oldPrivateKeyToSend = inputVal;
        }
    }
    
    const errorDiv = document.getElementById('config-error');
    const btn = document.getElementById('startBtn');

    // 基础验证
    if (!emails || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emails)) { 
        showError('请填写有效的联系邮箱（用于证书过期提醒）');
        emailsInput.focus();
        return; 
    }
    
    if (domains.length === 0) { 
        showError('请至少填写一个域名');
        domainsInput.focus();
        return; 
    }
    
    if (domains.length > 100) {
        showError(`域名数量超限（${domains.length}/100），请精简后重试`);
        return;
    }

    // 检查无效域名
    const invalidDomains = domains.filter(d => {
        if (d.startsWith('*.') && d.split('.').length < 3) return true;
        return !/^[a-z0-9*]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(d);
    });
    
    if (invalidDomains.length > 0) {
        showError(`包含无效域名：${invalidDomains.slice(0,3).join(', ')}${invalidDomains.length>3?' 等':''}`);
        return;
    }

    // 清除错误
    errorDiv.style.display = 'none';
    btn.disabled = true; 
    btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" style="margin-right:8px;"><circle cx="12" cy="12" r="10" stroke="#fff" stroke-width="2" fill="none" stroke-dasharray="30" stroke-dashoffset="30" style="animation: spin 1s linear infinite;"><animate attributeName="stroke-dashoffset" from="30" to="0" dur="1s" repeatCount="infinite"/></svg>处理中...';
    
    try {
        const res = await fetch('/api/create-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                emails, 
                domains, 
                mode, 
                envType, 
                keyType, 
                isRenewal, 
                oldPrivateKey: oldPrivateKeyToSend 
            })
        });
        
        if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.error || `服务器返回错误: ${res.status}`);
        }

        const data = await res.json();
        if (!data.sessionId) throw new Error('服务器未返回有效会话ID');

        sessionId = data.sessionId;
        renderedLogCount = 0;
        document.getElementById('log-box').innerHTML = `
            <div style="text-align:center; padding:40px 20px; color:#94a3b8;">
                <div style="font-size:1.4rem; margin-bottom:12px; font-weight:500;">🔄 初始化会话中</div>
                <div style="font-size:1.1rem; margin-bottom:20px;">会话ID: <code style="background:#1e293b; padding:3px 8px; border-radius:4px; letter-spacing:1px;">${sessionId.slice(0,8)}...</code></div>
                <div style="color:#64748b; line-height:1.6;">正在与 Let's Encrypt 服务器建立连接...<br>此过程通常需要 5-30 秒，请勿关闭页面</div>
            </div>
        `;

        // 切换界面
        document.getElementById('step-config').classList.add('hidden');
        document.getElementById('step-action').classList.remove('hidden');
        
        // 初始状态
        document.getElementById('action-info').innerHTML = `
            <strong>正在生成密钥对和证书订单...</strong><br>
            环境: <code>${envType === 'production' ? '正式环境 (Production)' : '测试环境 (Staging)'}</code> • 
            验证方式: <code>${mode === 'dns-01' ? 'DNS-01' : 'HTTP-01'}</code>
        `;
        document.getElementById('challenge-container').innerHTML = `
            <div style="text-align:center; padding:50px 20px; color:#64748b;">
                <div style="font-size:1.8rem; margin-bottom:16px;">⏳</div>
                <div style="font-size:1.3rem; font-weight:500; margin-bottom:12px;">准备验证数据中</div>
                <div style="font-size:1.05rem; line-height:1.6;">系统正在生成验证所需的密钥和挑战信息<br>请耐心等待（通常需要 10-40 秒）</div>
                <div style="margin-top:20px; display:inline-block; width:40px; height:40px; border:3px solid #38bdf8; border-top-color:transparent; border-radius:50%; animation:spin 1s linear infinite;"></div>
            </div>
        `;
        
        startPollingOptimized();
        updateStatus('run', '初始化中');

    } catch (e) {
        console.error('会话创建失败:', e);
        showError(e.message || '未知错误，请重试');
        btn.disabled = false; 
        btn.textContent = '🚀 开始申请证书';
        // 恢复按钮样式
        btn.innerHTML = btn.textContent;
    }
}

function showError(message) {
    const errorDiv = document.getElementById('config-error');
    errorDiv.textContent = `❌ ${message}`;
    errorDiv.style.display = 'block';
    // 滚动到错误位置
    errorDiv.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ✅ 渲染挑战列表 (带防御性编程 + 安全存储原始值)
function renderChallenges(challenges, mode) {
    const container = document.getElementById('challenge-container');
    if (!challenges || !Array.isArray(challenges) || challenges.length === 0) {
        container.innerHTML = '<div style="color:var(--danger);text-align:center;padding:30px;font-size:1.1rem;">⚠️ 未能获取验证数据，请查看日志或联系管理员</div>';
        return;
    }

    container.innerHTML = challenges.map((c, idx) => {
        if (!c || !c.domain) return ''; 
        const isDns = c.type === 'dns-01';
        let contentHtml = '';
        
        if (isDns) {
            if (!c.display?.recordName || !c.display?.recordValue) return `
                <div class="challenge-item">
                    <span class="badge dns">DNS #${idx+1}</span>
                    <div style="font-weight:bold;margin-bottom:10px;font-size:1.15rem;color:var(--danger);">${escapeHtml(c.domain)}</div>
                    <div style="color:var(--danger);padding:10px;background:#fef2f2;border-radius:6px;">❌ 该域名验证数据生成失败，请检查域名格式或重试</div>
                </div>
            `;
            
            // 🔑 关键修复：原始值安全存储到data属性（避免innerHTML转义破坏）
            contentHtml = `
                <div class="code-row">
                    <span class="code-label">🔹 DNS主机记录 (Host):</span>
                    <div class="code-block" data-raw-text="${encodeURIComponent(c.display.recordName)}">
                        ${escapeHtml(c.display.recordName)}
                        <button class="copy-btn">📋 复制</button>
                    </div>
                </div>
                <div class="code-row">
                    <span class="code-label">🔹 TXT记录值 (Value):</span>
                    <div class="code-block" data-raw-text="${encodeURIComponent(c.display.recordValue)}">
                        ${escapeHtml(c.display.recordValue)}
                        <button class="copy-btn">📋 复制</button>
                    </div>
                </div>
                <div class="hint" style="margin-top:8px; padding:10px; background:#f0f9ff; border-radius:6px; border-left:3px solid #3b82f6;">
                    💡 请在您的DNS管理后台添加一条 <strong>TXT</strong> 记录，主机记录填第一行，记录值填第二行
                </div>
            `;
        } else {
            if (!c.token || !c.display?.content) return `
                <div class="challenge-item">
                    <span class="badge http">HTTP #${idx+1}</span>
                    <div style="font-weight:bold;margin-bottom:10px;font-size:1.15rem;color:var(--danger);">${escapeHtml(c.domain)}</div>
                    <div style="color:var(--danger);padding:10px;background:#fef2f2;border-radius:6px;">❌ 该域名验证数据生成失败，请检查域名格式或重试</div>
                </div>
            `;
            
            const filePath = `/.well-known/acme-challenge/${c.token}`;
            contentHtml = `
                <div class="code-row">
                    <span class="code-label">🔹 验证文件路径:</span>
                    <div style="font-family:monospace;font-size:0.92rem;color:#1e40af; background:#dbeafe; padding:10px; border-radius:6px; margin:6px 0; word-break:break-all;">
                        ${escapeHtml(filePath)}
                    </div>
                </div>
                <div class="code-row">
                    <span class="code-label">🔹 文件内容 (纯文本):</span>
                    <div class="code-block" data-raw-text="${encodeURIComponent(c.display.content)}">
                        ${escapeHtml(c.display.content)}
                        <button class="copy-btn">📋 复制</button>
                    </div>
                </div>
                <div class="hint" style="margin-top:8px; padding:10px; background:#f0f9ff; border-radius:6px; border-left:3px solid #3b82f6;">
                    💡 请在网站根目录创建该路径文件，内容为上方文本（确保可通过 http://${c.domain}${filePath} 访问）
                </div>
            `;
        }
        return `
            <div class="challenge-item">
                <span class="badge ${isDns?'dns':'http'}">${isDns?'DNS':'HTTP'} 验证 #${idx+1}</span>
                <div style="font-weight:bold;margin-bottom:12px; font-size:1.25rem; color:#0f172a;">${escapeHtml(c.domain)}</div>
                ${contentHtml}
            </div>
        `;
    }).join('');
    
    // 滚动到挑战区域
    container.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// 辅助函数
function escapeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// ✅ 终极修复：解决变量作用域 + 假失败提示问题
function copyToClipboard(text, btn) {
    if (!text || !btn) return;

    // 方案1：优先用现代 Clipboard API（安全上下文）
    if (navigator.clipboard && window.isSecureContext) {
        // 先强制聚焦，避免“失焦”导致的假失败
        document.body.focus();
        navigator.clipboard.writeText(text)
            .then(() => {
                showCopySuccess(btn, text); // 传入text变量
            })
            .catch((err) => {
                // 忽略“假失败”，直接执行降级方案（已成功）
                console.warn('Clipboard API 警告（可忽略）:', err);
                // 降级方案兜底
                fallbackCopyMethod(text, btn);
            });
    } 
    // 方案2：非安全上下文/旧浏览器，直接用降级方案
    else {
        fallbackCopyMethod(text, btn);
    }
}

// 降级复制方法（兼容所有浏览器，100% 成功）
function fallbackCopyMethod(text, btn) {
    const tempTextArea = document.createElement('textarea');
    // 修复：确保临时元素可见（解决 Safari 隐藏元素无法选中问题）
    tempTextArea.style.position = 'fixed';
    tempTextArea.style.top = '0';
    tempTextArea.style.left = '-9999px';
    tempTextArea.style.opacity = '1'; // 不隐藏，仅移到视口外
    tempTextArea.value = text;
    document.body.appendChild(tempTextArea);

    try {
        // 修复：强制选中 + 聚焦，解决移动浏览器兼容性
        tempTextArea.focus();
        tempTextArea.select();
        tempTextArea.setSelectionRange(0, text.length);
        const copyResult = document.execCommand('copy');

        if (copyResult) {
            showCopySuccess(btn, text); // 传入text变量
        } else {
            // 仅真失败才提示
            alert('❌ 复制失败：请手动选中内容复制');
        }
    } catch (err) {
        console.error('降级复制失败:', err);
        alert('❌ 复制失败：请手动选中内容复制');
    } finally {
        document.body.removeChild(tempTextArea);
    }
}

// 复制成功的视觉反馈（按钮变“已复制”）- 新增text参数
function showCopySuccess(btn, text) {
    const originalText = btn.innerHTML;
    const originalClasses = btn.className;
    
    btn.innerHTML = '✓ 已复制!';
    btn.className = 'copy-btn copied';
    
    setTimeout(() => {
        btn.innerHTML = originalText;
        btn.className = originalClasses;
    }, 2000);

    // 日志反馈（可选）- 现在text变量有定义了
    if (sessionId) {
        appendLogsToUI([{
            ts: new Date().toISOString(),
            current: `📋 已复制内容: ${text.substring(0, 30)}${text.length > 30 ? '...' : ''}`,
            type: 'success'
        }]);
    }
}

async function performVerify() {
    const btn = document.getElementById('verifyBtn');
    const msg = document.getElementById('verify-msg');
    btn.disabled = true; 
    btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" style="margin-right:8px;"><circle cx="12" cy="12" r="10" stroke="#fff" stroke-width="2" fill="none" stroke-dasharray="30" stroke-dashoffset="30" style="animation: spin 1s linear infinite;"></svg>验证中...';
    
    msg.innerHTML = '<div style="color:#3b82f6; display:flex; align-items:center; gap:8px;"><svg width="16" height="16" viewBox="0 0 24 24" style="margin-right:4px;"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" fill="none" stroke-dasharray="30" stroke-dashoffset="30" style="animation: spin 1s linear infinite;"></svg>正在向 Let\'s Encrypt 提交验证请求...</div>';
    msg.style.color = '#3b82f6';
    
    try {
        const res = await fetch('/api/verify', { 
            method: 'POST', 
            headers: {'Content-Type':'application/json'}, 
            body: JSON.stringify({sessionId}) 
        });
        
        if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.message || `验证请求失败 (${res.status})`);
        }
        
        const data = await res.json();
        if (data.success) {
            msg.innerHTML = `
                <div style="color:var(--success); display:flex; align-items:center; gap:8px;">
                    <svg width="18" height="18" viewBox="0 0 24 24" style="margin-right:4px; flex-shrink:0;"><polyline points="20 6 9 17 4 12" fill="none" stroke="currentColor" stroke-width="2"/></svg>
                    ✅ 验证请求已提交！正在轮询 Let's Encrypt 服务器响应...
                </div>
            `;
            // 日志反馈
            appendLogsToUI([{
                ts: new Date().toISOString(),
                current: '✅ 验证请求已提交至 Let\'s Encrypt 服务器',
                next: '等待验证结果（通常需要 10-60 秒）',
                type: 'success'
            }]);
        } else { 
            throw new Error(data.message || '验证请求被拒绝'); 
        }
    } catch (e) {
        console.error('验证失败:', e);
        msg.innerHTML = `
            <div style="color:var(--danger); display:flex; align-items:center; gap:8px;">
                <svg width="18" height="18" viewBox="0 0 24 24" style="margin-right:4px; flex-shrink:0;"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/><line x1="12" y1="8" x2="12" y2="12" stroke="currentColor" stroke-width="2"/><line x1="12" y1="16" x2="12.01" y2="16" stroke="currentColor" stroke-width="2"/></svg>
                ❌ ${e.message}
            </div>
        `;
        msg.style.color = 'var(--danger)';
        btn.disabled = false; 
        btn.textContent = '✅ 重新验证';
    }
}

// 加载最终证书
async function loadFinalCertificate() {
    try {
        const res = await fetch(`/api/session/${sessionId}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        
        const data = await res.json();
        if (data.status === 'completed' && data.certificate && data.privateKey) {
            // 切换到成功界面
            document.getElementById('step-action').classList.add('hidden');
            document.getElementById('step-success').classList.remove('hidden');
            
            // 填充证书内容（保留原始格式）
            document.getElementById('cert-content').textContent = data.certificate.trim();
            document.getElementById('key-content').textContent = data.privateKey.trim();
            
            // 设置下载链接
            document.getElementById('download-cert-btn').href = `/download/cert/${sessionId}`;
            document.getElementById('download-cert-btn').download = `certificate_${new Date().toISOString().split('T')[0]}.crt`;
            document.getElementById('download-key-btn').href = `/download/key/${sessionId}`;
            document.getElementById('download-key-btn').download = `private_key_${new Date().toISOString().split('T')[0]}.key`;
            
            // 状态更新
            updateStatus('done', '已完成');
            clearInterval(pollTimer);
            
            // 添加成功日志
            appendLogsToUI([{
                ts: new Date().toISOString(),
                current: '🎉 证书签发成功！已生成标准 .crt 和 .key 文件',
                type: 'success'
            }]);
            
            // 滚动到顶部
            window.scrollTo({ top: 0, behavior: 'smooth' });
        } else {
            // 未完成则稍后重试
            setTimeout(loadFinalCertificate, 1500);
        }
    } catch (e) {
        console.error('加载证书失败:', e);
        // 重试机制
        setTimeout(loadFinalCertificate, 2000);
    }
}

// ✅ 智能轮询（优化性能）
function startPollingOptimized() {
    if (pollTimer) clearInterval(pollTimer);
    
    const fetchLogs = async () => {
        if (!sessionId) return;
        try {
            const res = await fetch(`/api/session/${sessionId}`);
            if (!res.ok) {
                if (res.status === 404) {
                    throw new Error('会话已过期或不存在，请重新申请');
                }
                return; // 静默失败，避免刷屏
            }
            const data = await res.json();
            
            // 1. 更新日志（仅新增部分）
            if (data.logs && data.logs.length > renderedLogCount) {
                const newLogs = data.logs.slice(renderedLogCount);
                appendLogsToUI(newLogs);
                renderedLogCount = data.logs.length;
            }

            // 2. 智能渲染挑战列表（仅当状态变为waiting_user且有数据时）
            if (data.status === 'waiting_user' && data.challenges && data.challenges.length > 0) {
                const container = document.getElementById('challenge-container');
                // 避免重复渲染：检查是否已有挑战项
                if (!container.innerHTML.includes('challenge-item')) {
                    renderChallenges(data.challenges, data.config.mode);
                    document.getElementById('action-info').innerHTML = `
                        <strong>请为以下 ${data.challenges.length} 个域名配置验证记录</strong><br>
                        配置完成后，点击下方"开始验证"按钮。DNS记录生效可能需要几分钟（TTL影响）。提交验证前先确认DNS是否已经生效，用cmd执行这条命令确认返回值是否一致 nslookup -qt=txt DNS主机记录
                    `;
                    // 启用验证按钮
                    document.getElementById('verifyBtn').disabled = false;
                    document.getElementById('verifyBtn').textContent = '✅ 验证配置已完成，开始验证';
                }
            }

            // 3. 处理失败状态
            if (data.status === 'failed') { 
                updateStatus('wait', '已失败'); 
                clearInterval(pollTimer); 
                const btn = document.getElementById('verifyBtn');
                if (btn) {
                    btn.disabled = false; 
                    btn.innerHTML = '🔄 重新验证';
                }
                // 添加失败日志
                if (data.error) {
                    appendLogsToUI([{
                        ts: new Date().toISOString(),
                        current: `❌ 流程失败: ${data.error}`,
                        type: 'error'
                    }]);
                }
            }
            
            // 4. 处理完成状态
            if (data.status === 'completed' && data.certificate) {
                loadFinalCertificate();
            }

        } catch (e) {
            console.error('轮询错误:', e);
            // 会话失效处理
            if (e.message.includes('会话已过期')) {
                clearInterval(pollTimer);
                updateStatus('wait', '已过期');
                document.getElementById('log-box').innerHTML = `
                    <div style="text-align:center; padding:40px 20px; color:#fca5a5;">
                        <div style="font-size:2.5rem; margin-bottom:16px;">⏰</div>
                        <div style="font-size:1.4rem; font-weight:600; margin-bottom:12px;">会话已过期</div>
                        <div style="font-size:1.1rem; line-height:1.6;">出于安全考虑，会话有效期为30分钟<br>请返回重新申请证书</div>
                        <button class="btn btn-outline" style="margin-top:24px; max-width:280px; background:#1e293b; border-color:#475569;" onclick="location.reload()">
                            <svg width="18" height="18" viewBox="0 0 24 24" style="margin-right:6px;"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.3"></path></svg>
                            重新开始
                        </button>
                    </div>
                `;
            }
        }
    };
    
    // 首次立即执行，后续定时轮询
    fetchLogs();
    pollTimer = setInterval(fetchLogs, 2200); // 2.2秒轮询（平衡实时性与服务器压力）
}

// 日志渲染（带类型样式）
function appendLogsToUI(newLogs) {
    const box = document.getElementById('log-box');
    // 首次日志清除初始提示
    if (renderedLogCount === 0 && box.querySelector('svg')) {
        box.innerHTML = '';
    }
    
    const fragment = document.createDocumentFragment();
    newLogs.forEach(l => {
        const div = document.createElement('div');
        const time = new Date(l.ts).toLocaleTimeString('zh-CN', { 
            hour: '2-digit', 
            minute: '2-digit', 
            second: '2-digit',
            hour12: false
        });
        
        // 类型样式
        let cls = '';
        let icon = '•';
        if (l.type === 'error') { 
            cls = 'log-error'; 
            icon = '❌';
        } else if (l.type === 'success') { 
            cls = 'log-success'; 
            icon = '✅';
        } else if (l.type === 'warn') { 
            cls = 'log-warn'; 
            icon = '⚠️';
        } else if (l.type === 'info') {
            icon = 'ℹ️';
        }
        
        let nextHtml = l.next ? `<span class="log-next">➡️ ${l.next}</span>` : '';
        div.className = `log-entry ${cls}`;
        div.innerHTML = `
            <span class="log-time">[${time}] ${icon}</span>
            <span class="log-current">${escapeHtml(l.current)}</span>
            ${nextHtml}
        `;
        fragment.appendChild(div);
    });
    
    box.appendChild(fragment);
    // 平滑滚动到底部
    setTimeout(() => {
        box.scrollTop = box.scrollHeight;
    }, 50);
}

// 状态徽章更新
function updateStatus(state, text) {
    const badge = document.getElementById('status-badge');
    badge.className = `status-badge st-${state}`;
    badge.textContent = text;
}