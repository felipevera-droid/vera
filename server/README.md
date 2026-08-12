# Servidor de IA (Gemini) — Portal de Estudios Vera

Este pequeño servidor gratuito hace que la app genere pruebas con IA **sin que nadie
tenga que poner una API key**. La clave de Gemini vive en el servidor (oculta); la app
solo le pega al servidor.

Se usa **Cloudflare Workers** (plan gratis, muy generoso) + **Google Gemini** (plan gratis).
Todo se hace desde el navegador, sin instalar nada. ~10 minutos.

---

## Paso 1 — Conseguir la clave de Gemini (gratis)

1. Entra a **https://aistudio.google.com/apikey** e inicia sesión con tu cuenta de Google.
2. Toca **“Create API key”** (Crear clave de API).
3. Copia la clave (empieza con `AIza...`). Guárdala un momento.

> Es gratis dentro de límites amplios; suficiente para uso familiar y de varios amigos.

---

## Paso 2 — Crear el Worker en Cloudflare (gratis)

1. Crea una cuenta en **https://dash.cloudflare.com/sign-up** (gratis).
2. En el panel, ve a **Workers & Pages → Create → Create Worker**.
3. Ponle un nombre (ej: `vera-ia`) y toca **Deploy** (crea uno de ejemplo).
4. Toca **Edit code**. Borra TODO el contenido y **pega el archivo
   [`gemini-worker.js`](./gemini-worker.js)** completo.
5. Toca **Deploy** (arriba a la derecha).

---

## Paso 3 — Guardar la clave de Gemini como secreto

1. En el Worker, ve a **Settings → Variables and Secrets** (o *Variables*).
2. Agrega una variable:
   - **Nombre:** `GEMINI_API_KEY`
   - **Valor:** tu clave `AIza...`
   - Márcala como **Secret / Encrypt**.
3. (Opcional) Otra variable `GEMINI_MODEL` = `gemini-2.0-flash` (por defecto ya usa ese;
   si tu cuenta no lo tuviera, prueba `gemini-1.5-flash`).
4. (Opcional, más seguro) `ALLOW_ORIGIN` = `https://felipevera-droid.github.io`
   para que solo tu app pueda usar el servidor.
5. Guarda y vuelve a **Deploy** si te lo pide.

---

## Paso 4 — Copiar la dirección y pegarla en la app

1. La dirección del Worker se ve así:
   `https://vera-ia.TU-USUARIO.workers.dev`
   (aparece en la portada del Worker; ábrela en el navegador: debe responder
   `{"ok":true,"service":"vera-gemini"}`).
2. En la app (Portal de Estudios Vera) → **Panel del papá** (PIN 1234) →
   **⚙️ Config → 🤖 Servidor de IA** → pega la dirección → **Guardar servidor**.
3. ¡Listo! Ahora en **✨ Crear prueba** puedes subir un PDF y generar con IA.

> La dirección del servidor se guarda en cada dispositivo. Cuando compartas la app con
> un amigo, pásale también esta dirección (o déjala tú configurada en su teléfono) para
> que él también genere con IA usando el mismo servidor gratis.

---

## ¿Qué recibe y devuelve el servidor?

- **Generar** (`mode: "generate"`): recibe `{name, grade, subject, topic, count, text, fileB64, mediaType}`
  y devuelve `{ test: { title, questions:[{type, q, options, answer, hint}] } }`.
- **Evaluar** (`mode: "evaluate"`): recibe `{question, modelAnswer, studentAnswer, name}`
  y devuelve `{veredicto, puntaje, bien, mejorar, recordar}`.

No guarda datos: solo traduce la petición de la app a Gemini y devuelve el resultado.
