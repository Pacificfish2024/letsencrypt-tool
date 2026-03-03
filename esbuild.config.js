// esbuild.config.js - 全平台通用构建配置
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

// 创建dist目录（如果不存在）
const distDir = path.join(__dirname, 'dist');
if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
}

// ESBuild构建配置
esbuild.build({
    entryPoints: ['server.js'],
    outfile: path.join(distDir, 'index.js'),
    platform: 'node',                // 关键：指定Node.js平台
    target: 'node16',                // 匹配你的engines版本
    format: 'cjs',                   // CommonJS格式（兼容所有边缘函数）
    bundle: true,                    // 打包所有依赖
    minify: false,                   // 不压缩（方便调试，生产可改为true）
    sourcemap: true,                 // 生成sourcemap（调试用）
    external: [                      // 排除Node内置模块（ESA已内置）
        'crypto',
        'fs',
        'path',
        'events',
        'net',
        'util',
        'http',
        'https',
        'stream',
        'url',
        'zlib',
        'querystring'
    ],
    loader: {
        '.js': 'js'
    }
}).then(() => {
    console.log('✅ 构建成功！输出目录：dist/');
}).catch((err) => {
    console.error('❌ 构建失败：', err.message);
    process.exit(1);
});