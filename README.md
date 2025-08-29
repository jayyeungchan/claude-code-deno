# Deno Claude to OpenAI API Proxy

这是一个基于 Deno 的 Claude API 到 OpenAI API 格式转换代理服务器，支持负载均衡。

## 环境变量配置

在运行服务之前，请设置以下环境变量：

### VERCEL_API_URL
设置 Vercel API 的 URL 地址：
```bash
export VERCEL_API_URL="https://your-vercel-api-url/v1/chat/completions"
```

### VERCEL_API_KEYS
设置多个 API 密钥用于负载均衡，使用逗号分隔：
```bash
export VERCEL_API_KEYS="key1,key2,key3,key4"
```

### CUSTOM_AUTH_KEY（可选）
设置自定义认证密钥，用于验证请求中的 Bearer token：
```bash
export CUSTOM_AUTH_KEY="your-secret-authentication-key"
```

**注意：** 如果设置了 `CUSTOM_AUTH_KEY`，所有对 `/v1/messages` 的请求都必须在 `Authorization` header 中包含正确的 Bearer token，格式为：
```
Authorization: Bearer your-secret-authentication-key
```

如果不设置此环境变量，则跳过认证验证。

## 运行服务

### 开发模式
```bash
deno task dev
```

### 生产模式
```bash
deno task start
```

### 手动运行
```bash
deno run --allow-net --allow-env main.ts
```

## API 端点

- `POST /v1/messages` - Claude API 兼容端点
- `GET /health` - 健康检查和密钥状态

## 功能特性

- ✅ Claude API 到 OpenAI API 格式转换
- ✅ 多 API 密钥负载均衡
- ✅ 自动重试机制
- ✅ 失败密钥自动恢复
- ✅ 流式响应支持
- ✅ 工具调用支持