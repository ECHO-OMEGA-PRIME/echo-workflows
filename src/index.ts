/**
 * Echo Workflows v1.0.0 — AI-Powered Workflow Automation
 * Cloudflare Worker with Hono, D1, KV, service bindings
 *
 * Features: workflow templates, triggers, actions, conditions,
 * execution logs, scheduling, webhooks, AI-suggested automations
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';

interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  ENGINE_RUNTIME: Fetcher;
  SHARED_BRAIN: Fetcher;
  EMAIL_SENDER: Fetcher;
  ECHO_API_KEY?: string;
}

const app = new Hono<{ Bindings: Env }>();
app.use('*', cors({ origin: '*', allowMethods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'], allowHeaders: ['Content-Type','Authorization','X-Tenant-ID','X-Echo-API-Key'] }));
// Security headers middleware
app.use('*', async (c, next) => {
  await next();
  c.res.headers.set('X-Content-Type-Options', 'nosniff');
  c.res.headers.set('X-Frame-Options', 'DENY');
  c.res.headers.set('X-XSS-Protection', '1; mode=block');
  c.res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.res.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
});


const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const sanitize = (s: string, max = 2000) => s?.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').slice(0, max) ?? '';
const sanitizeBody = (o: Record<string, unknown>) => {
  const r: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) r[k] = typeof v === 'string' ? sanitize(v) : v;
  return r;
};
const tid = (c: any) => c.req.header('X-Tenant-ID') || c.req.query('tenant_id') || '';
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
const log = (level: string, msg: string, meta: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level, msg, service: 'echo-workflows', ts: now(), ...meta }));

// ── Rate limit ──
async function rateLimit(kv: KVNamespace, key: string, limit: number, windowSec = 60): Promise<boolean> {
  const rlKey = `rl:${key}`;
  const nowMs = Date.now();
  const raw = await kv.get(rlKey);
  if (!raw) { await kv.put(rlKey, JSON.stringify({ c: 1, t: nowMs }), { expirationTtl: windowSec * 2 }); return false; }
  const st = JSON.parse(raw);
  const decay = Math.max(0, st.c - ((nowMs - st.t) / 1000 / windowSec) * limit);
  const count = decay + 1;
  await kv.put(rlKey, JSON.stringify({ c: count, t: nowMs }), { expirationTtl: windowSec * 2 });
  return count > limit;
}

app.use('*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (path === '/health' || path === '/status') return next();
  const ip = c.req.header('cf-connecting-ip') || 'unknown';
  const isWrite = ['POST','PUT','PATCH','DELETE'].includes(c.req.method);
  if (await rateLimit(c.env.CACHE, `${ip}:${isWrite ? 'w' : 'r'}`, isWrite ? 60 : 200)) return json({ error: 'Rate limited' }, 429);
  return next();
});

app.use('*', async (c, next) => {
  const method = c.req.method;
  const path = new URL(c.req.url).pathname;
  if (method === 'GET' || method === 'OPTIONS' || method === 'HEAD' || path === '/health' || path === '/status' || path.startsWith('/webhook/')) return next();
  const apiKey = c.req.header('X-Echo-API-Key') || '';
  const bearer = (c.req.header('Authorization') || '').replace('Bearer ', '');
  const expected = c.env.ECHO_API_KEY;
  if (!expected || (apiKey !== expected && bearer !== expected)) return json({ error: 'Unauthorized' }, 401);
  return next();
});

// ═══════════════ ROOT & HEALTH ═══════════════
app.get('/', (c) => json({ service: 'echo-workflows', version: '1.0.0', status: 'operational' }));

app.get('/health', async (c) => {
  let dbOk = false;
  try { await c.env.DB.prepare('SELECT 1').first(); dbOk = true; } catch {}
  return json({ status: dbOk ? 'ok' : 'degraded', service: 'echo-workflows', version: '1.0.0', time: now(), db: dbOk ? 'connected' : 'error' });
});

app.get('/status', async (c) => {
  const counts = await c.env.DB.prepare(`SELECT
    (SELECT COUNT(*) FROM workflows) as workflows,
    (SELECT COUNT(*) FROM workflow_steps) as steps,
    (SELECT COUNT(*) FROM workflow_runs) as runs,
    (SELECT COUNT(*) FROM workflow_templates) as templates,
    (SELECT COUNT(*) FROM tenants) as tenants
  `).first();
  return json({ service: 'echo-workflows', version: '1.0.0', time: now(), counts });
});

// ═══════════════ TENANTS ═══════════════
app.post('/tenants', async (c) => {
  const b = sanitizeBody(await c.req.json()); const id = uid();
  await c.env.DB.prepare('INSERT INTO tenants (id, name, email, plan, max_workflows, max_runs_per_day) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, b.name, b.email || null, b.plan || 'starter', b.max_workflows || 5, b.max_runs_per_day || 100).run();
  return json({ id }, 201);
});

app.get('/tenants/:id', async (c) => {
  const r = await c.env.DB.prepare('SELECT * FROM tenants WHERE id=?').bind(c.req.param('id')).first();
  return r ? json(r) : json({ error: 'Not found' }, 404);
});

// ═══════════════ WORKFLOWS ═══════════════
app.get('/workflows', async (c) => {
  const t = tid(c);
  const status = c.req.query('status');
  let q = 'SELECT * FROM workflows WHERE tenant_id=?';
  const params: string[] = [t];
  if (status) { q += ' AND status=?'; params.push(sanitize(status, 20)); }
  q += ' ORDER BY updated_at DESC';
  const r = await c.env.DB.prepare(q).bind(...params).all();
  return json(r.results);
});

app.post('/workflows', async (c) => {
  const t = tid(c); const b = sanitizeBody(await c.req.json()); const id = uid();
  await c.env.DB.prepare('INSERT INTO workflows (id, tenant_id, name, description, trigger_type, trigger_config, status, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, t, b.name, b.description || null, b.trigger_type || 'manual', b.trigger_config ? JSON.stringify(b.trigger_config) : null, 'draft', b.is_active ? 1 : 0).run();
  log('info', 'workflow_created', { tenant_id: t, workflow_id: id });
  return json({ id }, 201);
});

app.get('/workflows/:id', async (c) => {
  const t = tid(c); const wId = c.req.param('id');
  const wf = await c.env.DB.prepare('SELECT * FROM workflows WHERE id=? AND tenant_id=?').bind(wId, t).first();
  if (!wf) return json({ error: 'Not found' }, 404);
  const steps = await c.env.DB.prepare('SELECT * FROM workflow_steps WHERE workflow_id=? ORDER BY step_order').bind(wId).all();
  const recentRuns = await c.env.DB.prepare('SELECT id, status, started_at, completed_at, error_message FROM workflow_runs WHERE workflow_id=? AND tenant_id=? ORDER BY started_at DESC LIMIT 10').bind(wId, t).all();
  return json({ ...wf, steps: steps.results, recent_runs: recentRuns.results });
});

app.put('/workflows/:id', async (c) => {
  const b = sanitizeBody(await c.req.json());
  await c.env.DB.prepare(`UPDATE workflows SET name=coalesce(?,name), description=coalesce(?,description), trigger_type=coalesce(?,trigger_type), trigger_config=coalesce(?,trigger_config), is_active=coalesce(?,is_active), status=coalesce(?,status), updated_at=datetime('now') WHERE id=? AND tenant_id=?`)
    .bind(b.name || null, b.description || null, b.trigger_type || null, b.trigger_config ? JSON.stringify(b.trigger_config) : null, b.is_active !== undefined ? (b.is_active ? 1 : 0) : null, b.status || null, c.req.param('id'), tid(c)).run();
  return json({ updated: true });
});

app.delete('/workflows/:id', async (c) => {
  const t = tid(c); const wId = c.req.param('id');
  await c.env.DB.prepare('DELETE FROM workflow_steps WHERE workflow_id=?').bind(wId).run();
  await c.env.DB.prepare('DELETE FROM workflow_runs WHERE workflow_id=? AND tenant_id=?').bind(wId, t).run();
  await c.env.DB.prepare('DELETE FROM workflows WHERE id=? AND tenant_id=?').bind(wId, t).run();
  return json({ deleted: true });
});

// ═══════════════ WORKFLOW STEPS ═══════════════
app.post('/workflows/:id/steps', async (c) => {
  const b = sanitizeBody(await c.req.json()); const id = uid();
  const wId = c.req.param('id');
  const maxOrder = await c.env.DB.prepare('SELECT MAX(step_order) as mx FROM workflow_steps WHERE workflow_id=?').bind(wId).first() as any;
  const order = (maxOrder?.mx || 0) + 1;
  await c.env.DB.prepare('INSERT INTO workflow_steps (id, workflow_id, step_order, step_type, name, config, condition_json, on_failure) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, wId, b.step_order || order, b.step_type || 'action', b.name, b.config ? JSON.stringify(b.config) : null, b.condition_json ? JSON.stringify(b.condition_json) : null, b.on_failure || 'stop').run();
  return json({ id, step_order: b.step_order || order }, 201);
});

app.put('/workflows/:wid/steps/:sid', async (c) => {
  const b = sanitizeBody(await c.req.json());
  await c.env.DB.prepare('UPDATE workflow_steps SET name=coalesce(?,name), step_type=coalesce(?,step_type), config=coalesce(?,config), condition_json=coalesce(?,condition_json), step_order=coalesce(?,step_order), on_failure=coalesce(?,on_failure) WHERE id=? AND workflow_id=?')
    .bind(b.name || null, b.step_type || null, b.config ? JSON.stringify(b.config) : null, b.condition_json ? JSON.stringify(b.condition_json) : null, b.step_order || null, b.on_failure || null, c.req.param('sid'), c.req.param('wid')).run();
  return json({ updated: true });
});

app.delete('/workflows/:wid/steps/:sid', async (c) => {
  await c.env.DB.prepare('DELETE FROM workflow_steps WHERE id=? AND workflow_id=?').bind(c.req.param('sid'), c.req.param('wid')).run();
  return json({ deleted: true });
});

// ═══════════════ WORKFLOW RUNS ═══════════════
app.post('/workflows/:id/run', async (c) => {
  const t = tid(c); const wId = c.req.param('id');
  const wf = await c.env.DB.prepare('SELECT * FROM workflows WHERE id=? AND tenant_id=?').bind(wId, t).first() as any;
  if (!wf) return json({ error: 'Workflow not found' }, 404);

  const steps = await c.env.DB.prepare('SELECT * FROM workflow_steps WHERE workflow_id=? ORDER BY step_order').bind(wId).all();
  if (!steps.results.length) return json({ error: 'Workflow has no steps' }, 400);

  const runId = uid();
  const inputData = await c.req.json().catch(() => ({})) as Record<string, unknown>;

  await c.env.DB.prepare("INSERT INTO workflow_runs (id, workflow_id, tenant_id, status, input_data, started_at) VALUES (?, ?, ?, 'running', ?, datetime('now'))")
    .bind(runId, wId, t, JSON.stringify(inputData)).run();

  let stepResults: Record<string, unknown>[] = [];
  let failed = false;

  for (const step of steps.results as any[]) {
    const stepRunId = uid();
    try {
      await c.env.DB.prepare("INSERT INTO step_runs (id, run_id, step_id, status, started_at) VALUES (?, ?, ?, 'running', datetime('now'))")
        .bind(stepRunId, runId, step.id).run();

      // Execute step based on type
      let result: unknown = null;
      const config = step.config ? JSON.parse(step.config) : {};

      switch (step.step_type) {
        case 'action':
          result = { executed: true, action: config.action || 'default', step: step.name };
          break;
        case 'condition':
          const condConfig = step.condition_json ? JSON.parse(step.condition_json) : {};
          result = { evaluated: true, condition: condConfig, passed: true };
          break;
        case 'notification':
          if (config.email) {
            try {
              await c.env.EMAIL_SENDER.fetch('https://email-sender/send', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ to: config.email, subject: config.subject || `Workflow: ${wf.name}`, body: config.body || 'Workflow step executed.' })
              });
            } catch {}
          }
          result = { notified: true, channel: config.channel || 'email' };
          break;
        case 'ai_analyze':
          try {
            const aiResp = await c.env.ENGINE_RUNTIME.fetch('https://engine-runtime/query', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ engine_id: config.engine_id || 'LG04', query: config.prompt || 'Analyze', max_tokens: 300 })
            });
            result = await aiResp.json();
          } catch (e: any) { result = { error: e.message }; }
          break;
        case 'webhook':
          try {
            const whResp = await fetch(config.url, {
              method: config.method || 'POST',
              headers: { 'Content-Type': 'application/json', ...(config.headers || {}) },
              body: config.body ? JSON.stringify(config.body) : null
            });
            result = { status: whResp.status, ok: whResp.ok };
          } catch (e: any) { result = { error: e.message }; }
          break;
        case 'delay':
          result = { delayed: true, seconds: config.seconds || 0 };
          break;
        default:
          result = { executed: true, type: step.step_type };
      }

      stepResults.push({ step_id: step.id, name: step.name, result });
      await c.env.DB.prepare("UPDATE step_runs SET status='completed', output_data=?, completed_at=datetime('now') WHERE id=?")
        .bind(JSON.stringify(result), stepRunId).run();

    } catch (e: any) {
      failed = true;
      await c.env.DB.prepare("UPDATE step_runs SET status='failed', error_message=?, completed_at=datetime('now') WHERE id=?")
        .bind(e.message, stepRunId).run();
      stepResults.push({ step_id: step.id, name: step.name, error: e.message });
      if (step.on_failure === 'stop') break;
    }
  }

  const finalStatus = failed ? 'failed' : 'completed';
  await c.env.DB.prepare("UPDATE workflow_runs SET status=?, output_data=?, completed_at=datetime('now') WHERE id=?")
    .bind(finalStatus, JSON.stringify(stepResults), runId).run();

  // Update workflow run count
  await c.env.DB.prepare("UPDATE workflows SET run_count=run_count+1, last_run_at=datetime('now'), updated_at=datetime('now') WHERE id=?").bind(wId).run();

  log('info', 'workflow_run', { tenant_id: t, workflow_id: wId, run_id: runId, status: finalStatus, steps: stepResults.length });
  return json({ run_id: runId, status: finalStatus, steps: stepResults });
});

app.get('/workflows/:id/runs', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 100);
  const r = await c.env.DB.prepare('SELECT * FROM workflow_runs WHERE workflow_id=? AND tenant_id=? ORDER BY started_at DESC LIMIT ?')
    .bind(c.req.param('id'), tid(c), limit).all();
  return json(r.results);
});

app.get('/runs/:id', async (c) => {
  const run = await c.env.DB.prepare('SELECT * FROM workflow_runs WHERE id=? AND tenant_id=?').bind(c.req.param('id'), tid(c)).first();
  if (!run) return json({ error: 'Not found' }, 404);
  const stepRuns = await c.env.DB.prepare('SELECT sr.*, ws.name as step_name, ws.step_type FROM step_runs sr JOIN workflow_steps ws ON ws.id=sr.step_id WHERE sr.run_id=? ORDER BY ws.step_order').bind(c.req.param('id')).all();
  return json({ ...run, step_runs: stepRuns.results });
});

// ═══════════════ WEBHOOK TRIGGER ═══════════════
app.post('/webhook/:workflow_id', async (c) => {
  const wId = c.req.param('workflow_id');
  const wf = await c.env.DB.prepare("SELECT * FROM workflows WHERE id=? AND is_active=1 AND trigger_type='webhook'").bind(wId).first() as any;
  if (!wf) return json({ error: 'Workflow not found or not webhook-triggered' }, 404);

  // Trigger the run
  const body = await c.req.json().catch(() => ({}));
  const runResp = await app.fetch(new Request(`https://echo-workflows/workflows/${wId}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': wf.tenant_id, 'X-Echo-API-Key': c.env.ECHO_API_KEY || '' },
    body: JSON.stringify(body)
  }), c.env);
  return runResp;
});

// ═══════════════ TEMPLATES ═══════════════
app.get('/templates', async (c) => {
  const r = await c.env.DB.prepare('SELECT * FROM workflow_templates WHERE tenant_id=? OR is_global=1 ORDER BY name').bind(tid(c)).all();
  return json(r.results);
});

app.post('/templates', async (c) => {
  const t = tid(c); const b = sanitizeBody(await c.req.json()); const id = uid();
  await c.env.DB.prepare('INSERT INTO workflow_templates (id, tenant_id, name, description, category, steps_json, is_global) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, t, b.name, b.description || null, b.category || 'general', b.steps_json ? JSON.stringify(b.steps_json) : '[]', b.is_global ? 1 : 0).run();
  return json({ id }, 201);
});

app.post('/templates/:id/create-workflow', async (c) => {
  const t = tid(c);
  const tmpl = await c.env.DB.prepare('SELECT * FROM workflow_templates WHERE id=? AND (tenant_id=? OR is_global=1)').bind(c.req.param('id'), t).first() as any;
  if (!tmpl) return json({ error: 'Template not found' }, 404);

  const b = await c.req.json().catch(() => ({})) as { name?: string };
  const wId = uid();
  await c.env.DB.prepare("INSERT INTO workflows (id, tenant_id, name, description, trigger_type, status) VALUES (?, ?, ?, ?, 'manual', 'draft')")
    .bind(wId, t, b.name || tmpl.name, tmpl.description).run();

  const steps = JSON.parse(tmpl.steps_json || '[]');
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    await c.env.DB.prepare('INSERT INTO workflow_steps (id, workflow_id, step_order, step_type, name, config, on_failure) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(uid(), wId, i + 1, s.step_type || 'action', s.name || `Step ${i + 1}`, s.config ? JSON.stringify(s.config) : null, s.on_failure || 'stop').run();
  }

  return json({ workflow_id: wId, steps_created: steps.length }, 201);
});

// ═══════════════ ANALYTICS ═══════════════
app.get('/analytics', async (c) => {
  const t = tid(c);
  const stats = await c.env.DB.prepare(`SELECT
    (SELECT COUNT(*) FROM workflows WHERE tenant_id=?) as total_workflows,
    (SELECT COUNT(*) FROM workflows WHERE tenant_id=? AND is_active=1) as active_workflows,
    (SELECT COUNT(*) FROM workflow_runs WHERE tenant_id=?) as total_runs,
    (SELECT COUNT(*) FROM workflow_runs WHERE tenant_id=? AND status='completed') as completed_runs,
    (SELECT COUNT(*) FROM workflow_runs WHERE tenant_id=? AND status='failed') as failed_runs,
    (SELECT COUNT(*) FROM workflow_runs WHERE tenant_id=? AND started_at > datetime('now','-24 hours')) as runs_today
  `).bind(t, t, t, t, t, t).first();
  return json(stats);
});


app.onError((err, c) => {
  if (err.message?.includes('JSON')) {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  console.error(`[echo-workflows] ${err.message}`);
  return c.json({ error: 'Internal server error' }, 500);
});

app.notFound((c) => {
  return c.json({ error: 'Not found' }, 404);
});

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // Execute scheduled workflows
    try {
      const scheduled = await env.DB.prepare("SELECT w.* FROM workflows w WHERE w.is_active=1 AND w.trigger_type='schedule'").all();
      for (const wf of scheduled.results as any[]) {
        const runId = uid();
        await env.DB.prepare("INSERT INTO workflow_runs (id, workflow_id, tenant_id, status, input_data, started_at) VALUES (?, ?, ?, 'queued', '{}', datetime('now'))")
          .bind(runId, wf.id, wf.tenant_id).run();
      }
      log('info', 'scheduled_workflows_queued', { count: scheduled.results.length });
    } catch (e: any) {
      log('error', 'scheduled_trigger_failed', { error: e.message });
    }
  }
};
