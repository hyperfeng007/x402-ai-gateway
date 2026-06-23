# x402-ai-gateway — Design Notes

## Background

HTTP 402 "Payment Required" is reserved in the spec but historically unused.
A new wave of tooling (Coinbase x402, Cloudflare, etc.) is reviving it as a
clean way to monetize APIs without accounts, API keys, or subscriptions.

This gateway demonstrates a working implementation: clients send a request →
get 402 with payment instructions → pay USDC on Base/Polygon → retry → get
AI response.

## Architecture

```
                ┌─────────────────┐
   client ───►  │  x402 Gateway   │ ───► upstream LLM
                │  (this server)  │
                │  :4001          │
                └─────────────────┘
                      │
                      ▼
            x402 settlement layer
            (USDC on Base/Polygon)
```

- Single Node.js process, no external DB
- Pricing per upstream loaded from `x402-manifest.json`
- All upstream auth keys come from environment variables
- Per-IP nonce / quota tracking is in-memory (sufficient for demo / single-instance)

## Pricing Tiers (default)

| Upstream | Per call | Notes |
|---|---|---|
| Kimi | $0.003 | cheapest, fast |
| GLM | $0.004 | Chinese-optimized |
| Qwen | $0.004 | Chinese-optimized |
| DeepSeek | $0.005 | coding-tuned |
| MiniMax | $0.005 | fallback |

## Endpoints

- `GET /` — service info
- `GET /.well-known/x402` — x402 manifest (machine-readable)
- `GET /v1/{provider}/chat` — paid chat proxy
- `GET /health` — liveness
- `GET /v1/echo` — free test endpoint

## x402 Flow

1. Client: `GET /v1/kimi/chat?q=hello`
2. Server: `402 Payment Required` + `WWW-Authenticate: x402 payTo=0x...`
3. Client reads `/.well-known/x402`, pays USDC, gets tx hash
4. Client retries with `X-Payment: <tx_hash>` header
5. Server verifies payment (on-chain or via facilitator), forwards, returns

## Free Quota

Each IP gets 3 free calls per hour, used to let developers try the API
before paying. Implemented in-memory; resets on restart.

## What this is NOT

- Not a production billing system (no persistent nonce DB, no auth audit log)
- Not a multi-tenant gateway (single wallet, single config)
- Not a hosted service (you run it yourself)

It is a working reference implementation of the x402 protocol with realistic
upstream choices.
