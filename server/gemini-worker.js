/* ============================================================
   Servidor de IA (Gemini) — Portal de Estudios Vera
   Cloudflare Worker gratuito. La API key de Gemini vive aquí
   como "secret" (GEMINI_API_KEY); la app nunca la ve.

   Variables (Cloudflare → Settings → Variables and Secrets):
     - GEMINI_API_KEY (Secret)  → clave de Google AI Studio (AIza...)
     - GEMINI_MODEL   (opcional) → forzar un modelo; si no, usa cadena auto
     - ALLOW_ORIGIN   (opcional) → por defecto "*"

   Prueba en el navegador:
     - https://TU-WORKER.workers.dev/           → {ok, version}
     - https://TU-WORKER.workers.dev/?diag=1     → qué modelo funciona + lista
   ============================================================ */

const VERSION = 'v3-chain-diag';

// Cadena de modelos: se prueba en orden hasta que uno responda 200.
// Los alias "*-latest" los mantiene Google disponibles para todos.
const MODEL_CHAIN = [
  'gemini-flash-latest',
  'gemini-flash-lite-latest',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-1.5-flash',
];

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const key = env.GEMINI_API_KEY;
    const forced = env.GEMINI_MODEL || '';

    if (request.method === 'GET') {
      const u = new URL(request.url);
      if (u.searchParams.get('diag') === '1') {
        if (!key) return json({ ok: false, error: 'Falta GEMINI_API_KEY en el servidor' }, 200, cors);
        return json(await diagnose(forced, key), 200, cors);
      }
      return json({ ok: true, service: 'vera-gemini', version: VERSION }, 200, cors);
    }
    if (request.method !== 'POST') return json({ error: 'Usa POST' }, 405, cors);
    if (!key) return json({ error: 'Falta configurar GEMINI_API_KEY en el servidor' }, 500, cors);

    let body;
    try { body = await request.json(); } catch { return json({ error: 'JSON inválido' }, 400, cors); }

    try {
      const out = body.mode === 'evaluate'
        ? await evaluate(body, forced, key)
        : await generate(body, forced, key);
      return json(out, 200, cors);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 502, cors);
    }
  },
};

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...cors } });
}

async function listModels(key) {
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}&pageSize=1000`);
    if (!r.ok) return [];
    const d = await r.json();
    return (d.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => (m.name || '').replace(/^models\//, ''));
  } catch (e) { return []; }
}

async function tryModel(model, key, parts, schema) {
  let r;
  try {
    r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: { temperature: 0.6, responseMimeType: 'application/json', responseSchema: schema },
      }),
    });
  } catch (e) { return { ok: false, status: 0, err: String((e && e.message) || e) }; }
  if (!r.ok) return { ok: false, status: r.status, err: (await r.text()).slice(0, 180) };
  const d = await r.json();
  const txt = (d.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  if (!txt) return { ok: false, status: 200, err: 'respuesta vacía o bloqueada' };
  try { return { ok: true, data: JSON.parse(txt) }; }
  catch (e) { return { ok: false, status: 200, err: 'JSON inválido de Gemini' }; }
}

function candidateOrder(forced, extra) {
  const seen = new Set(); const order = [];
  for (const n of [forced, ...MODEL_CHAIN, ...(extra || [])]) {
    if (n && !seen.has(n) && !/vision|tts|image|embedding|aqa/i.test(n)) { seen.add(n); order.push(n); }
  }
  return order;
}

async function callGemini(forced, key, parts, schema) {
  let order = candidateOrder(forced);
  let last = 'No se encontró un modelo Gemini disponible para tu clave.';
  for (const m of order) {
    const res = await tryModel(m, key, parts, schema);
    if (res.ok) { res.data.__model = m; return res.data; }
    last = 'Gemini ' + res.status + ' (' + m + '): ' + res.err;
  }
  // Fallback: descubrir los modelos reales de la cuenta y probarlos
  const listed = (await listModels(key)).filter((n) => !order.includes(n));
  for (const m of candidateOrder('', listed)) {
    if (order.includes(m)) continue;
    const res = await tryModel(m, key, parts, schema);
    if (res.ok) { res.data.__model = m; return res.data; }
    last = 'Gemini ' + res.status + ' (' + m + '): ' + res.err;
  }
  throw new Error(last);
}

async function diagnose(forced, key) {
  const listed = await listModels(key);
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };
  const parts = [{ text: 'Responde solamente {"ok": true}' }];
  const order = candidateOrder(forced, listed);
  const tried = [];
  let working = null;
  for (const m of order.slice(0, 14)) {
    const res = await tryModel(m, key, parts, schema);
    tried.push({ model: m, ok: res.ok, status: res.status });
    if (res.ok) { working = m; break; }
  }
  return { ok: !!working, version: VERSION, workingModel: working, availableModels: listed, tried };
}

async function generate(b, forced, key) {
  const count = Math.max(4, Math.min(15, parseInt(b.count, 10) || 8));
  const schema = {
    type: 'object',
    properties: {
      title: { type: 'string' },
      questions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['mc', 'open'] },
            q: { type: 'string' },
            options: { type: 'array', items: { type: 'string' } },
            answer: { type: 'string' },
            hint: { type: 'string' },
          },
          required: ['type', 'q', 'answer', 'hint'],
        },
      },
    },
    required: ['title', 'questions'],
  };
  const instr =
    `Eres un profesor chileno experto. Crea una prueba de PRÁCTICA para ${b.name || 'un estudiante'}` +
    `${b.grade ? ' (' + b.grade + ')' : ''} de la materia "${b.subject || ''}"` +
    `${b.topic ? ', tema "' + b.topic + '"' : ''}, basándote en el material entregado.\n\n` +
    `Reglas:\n` +
    `- Exactamente ${count} preguntas, en español, calibradas para su edad y nivel.\n` +
    `- MEZCLA preguntas "mc" (selección múltiple con EXACTAMENTE 4 opciones en "options"; "answer" = texto EXACTO de la opción correcta) y "open" (desarrollo; "answer" = respuesta modelo de 1 a 3 frases; "options" vacío).\n` +
    `- Aproximadamente 60% mc y 40% open.\n` +
    `- Cada pregunta con "hint": una pista útil que oriente sin dar la respuesta.\n` +
    `- "title": corto y descriptivo del contenido.\n` +
    `- Básate SOLO en el material entregado; no inventes contenido ajeno.`;

  const parts = [];
  if (b.fileB64 && b.mediaType) parts.push({ inline_data: { mime_type: b.mediaType, data: b.fileB64 } });
  if (b.text && b.text.trim()) parts.push({ text: 'MATERIAL (texto):\n' + b.text.trim() });
  parts.push({ text: instr });

  const test = await callGemini(forced, key, parts, schema);
  (test.questions || []).forEach((q) => { if (q.type === 'mc' && !Array.isArray(q.options)) q.options = []; });
  return { test };
}

async function evaluate(b, forced, key) {
  const schema = {
    type: 'object',
    properties: {
      veredicto: { type: 'string', enum: ['correcto', 'parcial', 'incorrecto'] },
      puntaje: { type: 'integer' },
      bien: { type: 'string' },
      mejorar: { type: 'string' },
      recordar: { type: 'string' },
    },
    required: ['veredicto', 'puntaje', 'bien', 'mejorar', 'recordar'],
  };
  const prompt =
    `Eres un tutor escolar chileno, cálido y pedagógico. Evalúa la respuesta de ${b.name || 'el estudiante'}.\n\n` +
    `PREGUNTA: ${b.question || ''}\n` +
    `RESPUESTA ESPERADA: ${b.modelAnswer || ''}\n` +
    `RESPUESTA DEL ESTUDIANTE: ${b.studentAnswer || ''}\n\n` +
    `Devuelve: veredicto ("correcto" si captó lo esencial, "parcial", o "incorrecto"), ` +
    `puntaje (0 a 100), bien (1 frase alentadora, háblale de tú), mejorar (1 frase), ` +
    `recordar (1 frase con el concepto clave, simple y memorable).`;
  return await callGemini(forced, key, [{ text: prompt }], schema);
}
