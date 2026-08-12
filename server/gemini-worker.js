/* ============================================================
   Servidor de IA (Gemini) para el Portal de Estudios Vera
   ------------------------------------------------------------
   Cloudflare Worker gratuito. Guarda la API key de Gemini como
   "secret" (GEMINI_API_KEY) — la app NUNCA ve la clave.
   La app le pega a este Worker y él llama a Gemini.

   Variables (en Cloudflare → Settings → Variables):
     - GEMINI_API_KEY  (Secret)  → tu clave de Google AI Studio
     - GEMINI_MODEL    (opcional) → por defecto "gemini-2.0-flash"
     - ALLOW_ORIGIN    (opcional) → por defecto "*"; para más
        seguridad pon "https://felipevera-droid.github.io"
   ============================================================ */

export default {
  async fetch(request, env) {
    const origin = env.ALLOW_ORIGIN || '*';
    const cors = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    // Prueba rápida en el navegador
    if (request.method === 'GET') return json({ ok: true, service: 'vera-gemini' }, 200, cors);
    if (request.method !== 'POST') return json({ error: 'Usa POST' }, 405, cors);

    const key = env.GEMINI_API_KEY;
    if (!key) return json({ error: 'Falta configurar GEMINI_API_KEY en el servidor' }, 500, cors);
    const model = env.GEMINI_MODEL || ''; // vacío = usar la cadena automática

    let body;
    try { body = await request.json(); } catch { return json({ error: 'JSON inválido' }, 400, cors); }

    try {
      const out = body.mode === 'evaluate'
        ? await evaluate(body, key, model)
        : await generate(body, key, model);
      return json(out, 200, cors);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 502, cors);
    }
  },
};

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

// Cadena de modelos: se prueba en orden hasta que uno responda 200.
// Los alias "*-latest" los mantiene Google disponibles para todos (incl. cuentas nuevas).
const MODEL_CHAIN = [
  'gemini-flash-latest',
  'gemini-flash-lite-latest',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-1.5-flash',
];
async function callGemini(preferred, key, parts, schema) {
  const seen = new Set();
  const candidates = [preferred, ...MODEL_CHAIN].filter((n) => { if (!n || seen.has(n)) return false; seen.add(n); return true; });
  let lastErr = 'No se encontró un modelo Gemini disponible para tu clave.';
  for (const m of candidates) {
    let r;
    try {
      r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: { temperature: 0.6, responseMimeType: 'application/json', responseSchema: schema },
        }),
      });
    } catch (e) { lastErr = 'Red: ' + String((e && e.message) || e); continue; }
    if (r.ok) {
      const d = await r.json();
      const txt = (d.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
      if (!txt) throw new Error('Gemini no devolvió contenido (¿material muy largo o bloqueado?)');
      const out = JSON.parse(txt);
      out.__model = m; // informativo
      return out;
    }
    lastErr = 'Gemini ' + r.status + ' (' + m + '): ' + (await r.text()).slice(0, 160);
  }
  throw new Error(lastErr);
}

async function generate(b, key, model) {
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

  const test = await callGemini(model, key, parts, schema);
  (test.questions || []).forEach((q) => { if (q.type === 'mc' && !Array.isArray(q.options)) q.options = []; });
  return { test };
}

async function evaluate(b, key, model) {
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
    `puntaje (0 a 100 según cuánto coincide con lo esperado), ` +
    `bien (1 frase alentadora sobre lo que hizo bien, háblale de tú), ` +
    `mejorar (1 frase con lo que faltó), ` +
    `recordar (1 frase con el concepto clave, simple y memorable).`;
  return await callGemini(model, key, [{ text: prompt }], schema);
}
