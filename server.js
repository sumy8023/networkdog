const { exec } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');

const TOKEN_PLACEHOLDER = '在此填入你的PushPlus Token';

// 打包后从 exe 同级目录读配置，避免凭据进入二进制
function loadPushplusToken() {
    const baseDir = process.pkg ? path.dirname(process.execPath) : __dirname;
    try {
        const raw = JSON.parse(fs.readFileSync(path.join(baseDir, 'config.json'), 'utf8'));
        const token = String(raw.pushplusToken || '').trim();
        return (!token || token === TOKEN_PLACEHOLDER) ? null : token;
    } catch (e) {
        return null;
    }
}

let pushplusToken = loadPushplusToken();
let primaryIP = null;
let failureCount = 0;
let isSendingNotification = false;
let lastWasNormal = true;
let lastLogType = 'normal';
let lastAbnormalCount = 0;
let lastNotificationTime = 0;
const NOTIFICATION_COOLDOWN = 3600000; // 1小时内不重复发送通知

// 获取带时间戳的日志前缀
function getTimestamp() {
    const now = new Date();
    const year = now.getFullYear();
    const month = (now.getMonth() + 1).toString().padStart(2, '0');
    const day = now.getDate().toString().padStart(2, '0');
    const hours = now.getHours().toString().padStart(2, '0');
    const minutes = now.getMinutes().toString().padStart(2, '0');
    const seconds = now.getSeconds().toString().padStart(2, '0');
    
    return `[${year}-${month}-${day} ${hours}:${minutes}:${seconds}]`;
}

// 生成随机英文字符验证码
function generateRandomCode(length = 6) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

// 发送通知函数
function sendNotification() {
    return new Promise((resolve) => {
        if (!pushplusToken) {
            console.log(`${getTimestamp()} ⚠️ 未配置 PushPlus Token（复制 config.example.json 为 config.json 并填入），仅记录不推送`);
            isSendingNotification = false;
            lastNotificationTime = Date.now();
            resolve(false);
            return;
        }

        const randomCode = generateRandomCode(6);
        const message = encodeURIComponent(`机器今天主网络异常断开！请检查是否断电！${randomCode}`);
        const title = encodeURIComponent('设备网络切换提醒');
        
        const url = `https://www.pushplus.plus/send?token=${encodeURIComponent(pushplusToken)}&content=${message}&title=${title}`;
        
        console.log(`${getTimestamp()} 🚨 正在发送通知...`);
        
        https.get(url, (res) => {
            console.log(`${getTimestamp()} ✅ 通知发送成功 (验证码: ${randomCode})`);
            isSendingNotification = false;
            lastNotificationTime = Date.now();
            resolve(true);
        }).on('error', (err) => {
            console.log(`${getTimestamp()} ❌ 发送通知失败: ${err.message}`);
            isSendingNotification = false;
            resolve(false);
        });
    });
}

// 检测主网口是否还存在
function checkPrimaryInterfaceExists() {
    return new Promise((resolve) => {
        exec('ipconfig', (error, stdout) => {
            if (error) {
                resolve(false);
                return;
            }
            
            if (primaryIP && stdout.includes(primaryIP)) {
                resolve(true);
            } else {
                resolve(false);
            }
        });
    });
}

// 初始化主网口
exec('route print 0.0.0.0', (error, stdout) => {
    const lines = stdout.split('\n');
    let bestMetric = 999;
    
    for (const line of lines) {
        if (line.includes('0.0.0.0') && line.trim().startsWith('0.0.0.0')) {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 5) {
                const metric = parseInt(parts[parts.length-1]);
                if (metric < bestMetric) {
                    bestMetric = metric;
                    primaryIP = parts[3];
                }
            }
        }
    }
    
    if (primaryIP) {
        console.log(`${getTimestamp()} 监控主网口: ${primaryIP}`);
        startMonitoring();
    } else {
        console.log(`${getTimestamp()} ❌ 无法检测到主网口`);
    }
});

function startMonitoring() {
    console.log(`${getTimestamp()} 🚀 启动网络监控`);
    if (!pushplusToken) {
        console.log(`${getTimestamp()} ⚠️ PushPlus Token 未配置，检测到异常只记录不推送`);
        console.log(`${getTimestamp()}    复制 config.example.json 为 config.json 并填入你的 Token 即可开启推送`);
    }
    
    setInterval(async () => {
        try {
            // 获取当前接口
            const currentInterface = await new Promise(resolve => {
                exec('route print 0.0.0.0', (err, stdout) => {
                    if (err) {
                        console.log(`${getTimestamp()} ❌ 获取路由表失败: ${err.message}`);
                        resolve(null);
                        return;
                    }
                    
                    const lines = stdout.split('\n');
                    let currentIP = null;
                    let currentMetric = 999;
                    
                    for (const line of lines) {
                        if (line.includes('0.0.0.0') && line.trim().startsWith('0.0.0.0')) {
                            const parts = line.trim().split(/\s+/);
                            if (parts.length >= 5) {
                                const metric = parseInt(parts[parts.length-1]);
                                if (metric < currentMetric) {
                                    currentMetric = metric;
                                    currentIP = parts[3];
                                }
                            }
                        }
                    }
                    resolve(currentIP);
                });
            });
            
            // 检测主网口是否还存在
            const primaryInterfaceExists = await checkPrimaryInterfaceExists();
            
            // PING测试
            const isConnected = await new Promise(resolve => {
                exec('ping -n 1 223.5.5.5', (err, stdout) => {
                    resolve(!err && (stdout.includes('字节=32') || stdout.includes('TTL=')));
                });
            });
            
            // 判断是否已切换到备用网口
            const isUsingBackup = currentInterface !== primaryIP;
            
            // 判断是否主网口物理断开
            const isPhysicalDisconnect = isUsingBackup && !primaryInterfaceExists;
            
            // 检查是否在冷却期内
            const isInCooldown = Date.now() - lastNotificationTime < NOTIFICATION_COOLDOWN;
            
            if (isConnected && currentInterface === primaryIP) {
                // 情况1: 主网口正常，网络正常
                process.stdout.write(`${getTimestamp()} 💚 网络正常\r`);
                lastLogType = 'normal';
                
                // 重置状态
                if (!lastWasNormal) {
                    console.log(`\n${getTimestamp()} 💚 网络恢复正常`);
                    failureCount = 0;
                    lastAbnormalCount = 0;
                }
                lastWasNormal = true;
            } else if (isPhysicalDisconnect) {
                // 情况2: 主网口物理断开（网线被拔）
                if (lastLogType !== 'physical_disconnect') {
                    console.log(`\n${getTimestamp()} 🔌 检测到主网口物理断开: 接口=${currentInterface}, 主网口=${primaryIP}, PING=${isConnected ? '成功' : '失败'}`);
                    lastLogType = 'physical_disconnect';
                }
                
                // 如果不在冷却期内，立即发送通知
                if (!isSendingNotification && !isInCooldown) {
                    console.log(`${getTimestamp()} 🚨 检测到物理断开，发送通知`);
                    isSendingNotification = true;
                    await sendNotification();
                } else if (isInCooldown) {
                    // 显示冷却期剩余时间
                    const remainingTime = Math.ceil((NOTIFICATION_COOLDOWN - (Date.now() - lastNotificationTime)) / 60000);
                    process.stdout.write(`\r${getTimestamp()} 🔌 主网口物理断开 (${remainingTime}分钟后可再次通知)`);
                }
                
                lastWasNormal = false;
            } else if (currentInterface === primaryIP && !isConnected) {
                // 情况3: 主网口外网切断但物理连接正常
                failureCount++;
                
                // 只在第一次异常或异常状态变化时输出完整信息
                if (lastLogType !== 'abnormal' || lastAbnormalCount !== failureCount) {
                    console.log(`\n${getTimestamp()} ❌ 异常: 接口=${currentInterface}, 主网口=${primaryIP}, PING=失败, 主网口存在=${primaryInterfaceExists}`);
                    lastLogType = 'abnormal';
                    lastAbnormalCount = failureCount;
                }
                
                // 只在计数变化时更新计数显示
                if (lastAbnormalCount !== failureCount) {
                    process.stdout.write(`\r${getTimestamp()} 📊 主网口PING异常计数: ${failureCount}/3`);
                    lastAbnormalCount = failureCount;
                }
                
                // 达到阈值且不在冷却期内，立即发送通知
                if (failureCount >= 3 && !isSendingNotification && !isInCooldown) {
                    console.log(`\n${getTimestamp()} 🚨 主网口外网异常达到阈值，发送通知`);
                    isSendingNotification = true;
                    await sendNotification();
                } else if (isInCooldown) {
                    // 显示冷却期剩余时间
                    const remainingTime = Math.ceil((NOTIFICATION_COOLDOWN - (Date.now() - lastNotificationTime)) / 60000);
                    process.stdout.write(`\r${getTimestamp()} 📊 主网口PING异常计数: ${failureCount}/2 (${remainingTime}分钟后可再次通知)`);
                }
                
                lastWasNormal = false;
            } else {
                // 情况4: 其他异常情况
                if (lastLogType !== 'abnormal' || lastAbnormalCount !== failureCount) {
                    console.log(`\n${getTimestamp()} ❌ 异常: 接口=${currentInterface}, 主网口=${primaryIP}, PING=${isConnected ? '成功' : '失败'}, 主网口存在=${primaryInterfaceExists}`);
                    lastLogType = 'abnormal';
                    lastAbnormalCount = failureCount;
                }
                
                lastWasNormal = false;
            }
        } catch (error) {
            console.log(`${getTimestamp()} ❌ 监控错误: ${error.message}`);
            lastLogType = 'error';
        }
    }, 5000);
}

// 退出处理
process.on('SIGINT', () => {
    console.log(`\n${getTimestamp()} 👋 关闭监控`);
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log(`\n${getTimestamp()} 👋 关闭监控`);
    process.exit(0);
});