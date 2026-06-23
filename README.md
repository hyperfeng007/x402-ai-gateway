# x402-ai-gateway

A pay-per-call AI API gateway implementing the **HTTP 402 Payment Required** protocol on top of multiple LLM providers (Kimi / GLM / Qwen / DeepSeek / MiniMax).

Clients send a request → get a 402 with payment instructions → pay USDC on Base/Polygon → retry → get AI response.

## Why x402?

Standard HTTP `402 Payment Required` is reserved in the spec but unused. New tooling (Cloudflare, Coinbase, etc.) is reviving it as a clean way to monetize APIs without accounts / API keys / subscriptions.

This gateway demonstrates:
- A single endpoint that fans out to 5 upstream LLM providers
- USDC pricing per upstream ($0.003 - $0.005 per call)
- Per-IP free tier (3 calls/hour)
- Anti-replay nonce
- Wallet-based billing (no signup needed)

## Setup

```bash
npm install
export RECEIVE_WALLET="0xYourUSDCWallet"
export KIMI_GATEWAY_KEY="..."
export GLM_GATEWAY_KEY="..."
export QWEN_GATEWAY_KEY="..."
export DEEPSEEK_GATEWAY_KEY="..."
export MINIMAX_GATEWAY_KEY="..."
node server.js
# Server starts on :4001
```

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/` | Service info / pricing |
| GET | `/.well-known/x402` | x402 protocol manifest (machine-readable pricing) |
| GET | `/v1/{provider}/chat` | Proxy to upstream (payment required) |
| GET | `/health` | Liveness check |
| GET | `/v1/echo` | Free test endpoint (no payment) |

## Configuration

| Env var | Default | Description |
|---|---|---|
| `PORT` | `4001` | HTTP port |
| `RECEIVE_WALLET` | (required) | USDC receiving wallet (Base/Polygon) |
| `KIMI_GATEWAY_KEY` | `kimi-gateway-key` | Auth key for Kimi upstream |
| `GLM_GATEWAY_KEY` | `glm-web-gateway-key` | Auth key for GLM upstream |
| `QWEN_GATEWAY_KEY` | `qwen-gateway-key` | Auth key for Qwen upstream |
| `DEEPSEEK_GATEWAY_KEY` | `deepseek-gateway-key` | Auth key for DeepSeek upstream |
| `MINIMAX_GATEWAY_KEY` | `minimax-gateway-key` | Auth key for MiniMax upstream |

## x402 Flow

1. Client: `GET /v1/kimi/chat?q=hello`
2. Server: `402 Payment Required` + `WWW-Authenticate: x402` header pointing to `/.well-known/x402`
3. Client reads manifest, pays USDC to `RECEIVE_WALLET`, gets tx hash
4. Client retries: `GET /v1/kimi/chat?q=hello` + `X-Payment: <tx_hash>`
5. Server verifies payment, forwards to Kimi, returns response

See `DESIGN.md` for architecture notes and a worked example.

## License
MIT
