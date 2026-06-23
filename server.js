/**
 * Leo x402 AI Gateway
 * --------------------
 * Express proxy that wraps local AI gateways (Kimi/GLM/Qwen/DeepSeek/MiniMax)
 * behind an x402 USDC paywall.
 *
 *  - Discovery:    GET  /.well-known/x402        -> x402 manifest
 *                  GET  /x402-manifest           -> same
 *                  GET  /openapi.json            -> OpenAPI 3.1
 *  - Health:       GET  /health
 *  - Stats:        GET  /stats
 *  - Free echo:    POST /v1/echo/chat/completions
 *  - Paid AI:      POST /v1/{kimi|glm|qwen|deepseek|minimax}/chat/completions
 *
 *  Flow (x402):
 *    1. Client POSTs without payment header.
 *    2. Server replies 402 Payment Required with X402 challenge header + JSON body.
 *    3. Client pays USDC on-chain, retries with header `X-PAYMENT: <base64 payload>`.
 *    4. Server validates the proof (here: mock validator, length + signature stub).
 *    5. On success, request is forwarded to the corresponding upstream gateway.
 *
 *  Usage:
 *      PORT=4001 node server.js
 */

'use strict';

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// --------------------------------------------------------------------------
// Load manifest
// --------------------------------------------------------------------------
const MANIFEST_PATH = path.join(__dirname, 'x402-manifest.json');
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));

const PORT = parseInt(process.env.PORT || '4001', 10);
const HOST = process.env.HOST || '0.0.0.0';
const FACILITATOR_MODE = process.env.FACILITATOR_MODE || 'mock'; // 'mock' | 'strict'

// Upstream routing table
// key = URL path prefix → upstream gateway (port, auth key)
const UPSTREAMS = {
  '/v1/kimi/':     { port: 3007, key: process.env.KIMI_GATEWAY_KEY  || 'kimi-gateway-key',     name: 'kimi'     },
  '/v1/glm/':      { port: 3002, key: process.env.GLM_GATEWAY_KEY   || 'glm-web-gateway-key',  name: 'glm'      },
  '/v1/qwen/':     { port: 3006, key: process.env.QWEN_GATEWAY_KEY  || 'qwen-gateway-key',     name: 'qwen'     },
  '/v1/deepseek/': { port: 3009, key: process.env.DEEPSEEK_GATEWAY_KEY || 'deepseek-gateway-key', name: 'deepseek' },
  '/v1/minimax/':  { port: 3005, key: process.env.MINIMAX_GATEWAY_KEY || 'minimax-gateway-key', name: 'minimax'  },
};

// --------------------------------------------------------------------------
// In-memory state
// --------------------------------------------------------------------------
const stats = {
  startedAt: new Date().toISOString(),
  totalRequests: 0,
  paidRequests: 0,
  freeRequests: 0,
  rejectedRequests: 0,
  perUpstream: {},  // { kimi: { paid, free, total } }
};
Object.keys(UPSTREAMS).forEach(p => {
  const name = UPSTREAMS[p].name;
  stats.perUpstream[name] = { paid: 0, free: 0, total: 0 };
});

// IP → { count, resetAt }
const freeTierBuckets = new Map();
const FREE_TIER_LIMIT = manifest.free_tier?.requests_per_ip_per_hour ?? 3;
const FREE_TIER_WINDOW_MS = 60 * 60 * 1000;

// nonce → issuedAt (for replay-protection in mock mode)
const paymentNonces = new Map();
const NONCE_TTL_MS = 10 * 60 * 1000;

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------
function clientIp(req) {
  return (req.headers['x-forwarded-for']?.toString().split(',')[0].trim())
      || req.socket.remoteAddress
      || 'unknown';
}

function makeNonce() {
  return crypto.randomBytes(16).toString('hex');
}

function checkFreeTier(ip) {
  const now = Date.now();
  const bucket = freeTierBuckets.get(ip);
  if (!bucket || bucket.resetAt < now) {
    freeTierBuckets.set(ip, { count: 1, resetAt: now + FREE_TIER_WINDOW_MS });
    return true;
  }
  if (bucket.count < FREE_TIER_LIMIT) {
    bucket.count += 1;
    return true;
  }
  return false;
}

function paymentRequirementsFor(endpoint) {
  // Pick base network by default
  const base = manifest.settlement.networks.find(n => n.name === 'base') || manifest.settlement.networks[0];
  return {
    x402Version: 1,
    scheme: 'exact',
    network: base.name,
    chainId: base.chainId,
    resource: endpoint.path,
    description: endpoint.description,
    mimeType: 'application/json',
    payTo: endpoint.x402.payTo,
    asset: base.usdcContract,
    maxAmountRequired: endpoint.pricing.minAmount, // micro-units (e.g. 5000 = 0.005 USDC)
    maxTimeoutSeconds: endpoint.x402.maxTimeoutSeconds,
    outputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, choices: { type: 'array' } }
    },
    extra: {
      name: 'USD Coin',
      version: '2'
    }
  };
}

function build402Response(endpoint) {
  const reqs = paymentRequirementsFor(endpoint);
  const nonce = makeNonce();
  paymentNonces.set(nonce, Date.now());
  // Garbage-collect old nonces periodically
  for (const [n, ts] of paymentNonces) {
    if (Date.now() - ts > NONCE_TTL_MS) paymentNonces.delete(n);
  }
  reqs.extra.nonce = nonce;

  const challenge = `X402 realm="x402", amount="${reqs.maxAmountRequired}", currency="USDC", payTo="${reqs.payTo}", chainId="${reqs.chainId}", nonce="${nonce}"`;

  return {
    status: 402,
    headers: {
      'WWW-Authenticate': challenge,
      'X-Payment-Address': reqs.payTo,
      'X-Payment-Amount': reqs.maxAmountRequired,
      'X-Payment-Currency': 'USDC',
      'X-Payment-Chain-Id': String(reqs.chainId),
      'X-Payment-Nonce': nonce,
      'Content-Type': 'application/json'
    },
    body: {
      error: 'payment_required',
      message: 'This endpoint requires x402 USDC payment. See X-Payment-* response headers.',
      paymentRequirements: reqs
    }
  };
}

/**
 * Validate a payment payload.
 *
 * Mock mode (default): just require a base64-encoded JSON with shape
 *   { txHash: "0x...", payer: "0x...", nonce: "<issued nonce>" }
 * and a non-empty txHash ≥ 32 chars.
 *
 * Strict mode: would call a real facilitator (x402.org) — placeholder below.
 */
async function validatePayment(paymentHeader, endpoint) {
  if (!paymentHeader) return { ok: false, reason: 'no X-PAYMENT header' };

  let payload;
  try {
    payload = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf8'));
  } catch (e) {
    return { ok: false, reason: 'X-PAYMENT must be base64-encoded JSON' };
  }

  const reqs = paymentRequirementsFor(endpoint);

  if (!payload.txHash || typeof payload.txHash !== 'string' || payload.txHash.length < 32) {
    return { ok: false, reason: 'txHash missing or too short' };
  }
  if (!payload.payer || !/^0x[a-fA-F0-9]{40}$/.test(payload.payer)) {
    return { ok: false, reason: 'payer must be a 0x address' };
  }
  if (!paymentNonces.has(payload.nonce)) {
    return { ok: false, reason: 'unknown or expired nonce' };
  }
  if (payload.amount && String(payload.amount) !== reqs.maxAmountRequired) {
    return { ok: false, reason: `amount ${payload.amount} != required ${reqs.maxAmountRequired}` };
  }

  // Consume nonce (single-use)
  paymentNonces.delete(payload.nonce);

  if (FACILITATOR_MODE === 'strict') {
    // Placeholder: POST to real facilitator for on-chain verification
    // const ok = await axios.post('https://x402.org/facilitator/verify', { ... });
    // return { ok: ok.data.valid, reason: ok.data.reason };
    return { ok: true, mode: 'strict-stub' };
  }
  return { ok: true, mode: 'mock', txHash: payload.txHash };
}

// --------------------------------------------------------------------------
// Express app
// --------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logger
app.use((req, res, next) => {
  stats.totalRequests += 1;
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${req.method} ${req.path} ip=${clientIp(req)}`);
  next();
});

// ---- Discovery endpoints ----
app.get('/.well-known/x402', (req, res) => res.json(manifest));
app.get('/x402-manifest',    (req, res) => res.json(manifest));
app.get('/openapi.json',     (req, res) => res.json(buildOpenApi(manifest)));

function buildOpenApi(m) {
  return {
    openapi: '3.1.0',
    info: { title: m.name, version: m.version, description: m.description },
    servers: [{ url: '/' }],
    paths: Object.fromEntries(m.endpoints.map(e => [
      e.path, {
        post: {
          summary: e.name,
          description: e.description,
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object' } } }
          },
          responses: {
            200: { description: 'OpenAI-compatible chat completion' },
            402: {
              description: 'Payment Required (x402)',
              content: { 'application/json': { schema: { type: 'object' } } }
            }
          }
        }
      }
    ]))
  };
}

// ---- Health & stats ----
app.get('/health', (req, res) => res.json({
  ok: true,
  uptimeSec: Math.floor((Date.now() - new Date(stats.startedAt).getTime()) / 1000),
  upstreams: Object.fromEntries(Object.entries(UPSTREAMS).map(([p, u]) => [u.name, { port: u.port }])),
  facilitator: FACILITATOR_MODE
}));

app.get('/stats', (req, res) => res.json(stats));

// ---- Free echo endpoint (for x402 handshake test, price 0) ----
app.post('/v1/echo/chat/completions', (req, res) => {
  stats.perUpstream.echo = stats.perUpstream.echo || { paid: 0, free: 0, total: 0 };
  stats.perUpstream.echo.total += 1;
  stats.perUpstream.echo.free += 1;
  stats.freeRequests += 1;

  const prompt = req.body?.messages?.[0]?.content || '';
  res.json({
    id: 'echo-' + crypto.randomBytes(8).toString('hex'),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'echo',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: `[echo] ${prompt}\n\n— This is the free echo endpoint. Pay a real upstream (e.g. /v1/kimi/chat/completions) to get AI responses.`
      },
      finish_reason: 'stop'
    }],
    usage: { prompt_tokens: prompt.length, completion_tokens: 30, total_tokens: prompt.length + 30 }
  });
});

// ---- Paid AI endpoints ----
async function handlePaidEndpoint(req, res, endpoint, upstream) {
  const upstreamUrl = `http://127.0.0.1:${upstream.port}/v1/chat/completions`;

  // Free-tier short-circuit
  if (checkFreeTier(clientIp(req))) {
    stats.freeRequests += 1;
    stats.perUpstream[upstream.name].free += 1;
    console.log(`  → free tier (${upstream.name})`);
  } else {
    // x402 payment required
    const paymentHeader = req.headers['x-payment'];
    const validation = await validatePayment(paymentHeader, endpoint);
    if (!validation.ok) {
      stats.rejectedRequests += 1;
      const r402 = build402Response(endpoint);
      console.log(`  → 402 (${validation.reason})`);
      return res.status(r402.status)
                .set(r402.headers)
                .json(r402.body);
    }
    stats.paidRequests += 1;
    stats.perUpstream[upstream.name].paid += 1;
    console.log(`  → paid (${upstream.name}) txHash=${validation.txHash?.slice(0, 18)}…`);
  }

  stats.perUpstream[upstream.name].total += 1;

  // Forward to upstream with timeout
  try {
    const upstreamRes = await axios.post(upstreamUrl, req.body, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${upstream.key}`
      },
      timeout: (endpoint.x402.maxTimeoutSeconds || 60) * 1000,
      validateStatus: () => true  // pass through any status
    });
    res.status(upstreamRes.status).json(upstreamRes.data);
  } catch (e) {
    console.error(`  ! upstream ${upstream.name} error: ${e.message}`);
    res.status(502).json({
      error: 'upstream_error',
      upstream: upstream.name,
      message: e.message,
      hint: `Is the ${upstream.name} gateway running on port ${upstream.port}? Start it with: bash ${upstream.name}-gateway/start.sh`
    });
  }
}

for (const [prefix, upstream] of Object.entries(UPSTREAMS)) {
  // Find the matching endpoint in the manifest
  const endpoint = manifest.endpoints.find(e => e.path.startsWith(prefix));
  if (!endpoint) continue;
  app.post(prefix + 'chat/completions', (req, res) => handlePaidEndpoint(req, res, endpoint, upstream));
}

// ---- Fallback 404 ----
app.use((req, res) => {
  res.status(404).json({
    error: 'not_found',
    message: `Path ${req.method} ${req.path} is not exposed. See /.well-known/x402 for the manifest.`
  });
});

// --------------------------------------------------------------------------
// Boot
// --------------------------------------------------------------------------
app.listen(PORT, HOST, () => {
  console.log('================================================================');
  console.log(`  ${manifest.name}  v${manifest.version}`);
  console.log('================================================================');
  console.log(`  Listening on    http://${HOST}:${PORT}`);
  console.log(`  Discovery:      http://${HOST}:${PORT}/.well-known/x402`);
  console.log(`  Manifest:       http://${HOST}:${PORT}/x402-manifest`);
  console.log(`  OpenAPI:        http://${HOST}:${PORT}/openapi.json`);
  console.log(`  Health:         http://${HOST}:${PORT}/health`);
  console.log(`  Stats:          http://${HOST}:${PORT}/stats`);
  console.log(`  Settle to:      ${manifest.settlement.payTo}`);
  console.log('  Upstreams:');
  for (const [p, u] of Object.entries(UPSTREAMS)) {
    console.log(`     ${p}  →  http://127.0.0.1:${u.port}/v1/chat/completions`);
  }
  console.log(`  Facilitator:    ${FACILITATOR_MODE} mode`);
  console.log(`  Free tier:      ${FREE_TIER_LIMIT} req/IP/hour`);
  console.log('================================================================');
});
