# Subir NuTracker a Render (gratis) — paso a paso

La app ya está preparada: usa `PORT` automáticamente, con `NT_PIN` pide PIN de
acceso, y si defines las variables de Upstash guarda los datos ahí (obligatorio
en Render: su disco gratis se borra en cada reinicio).

## Qué vas a usar (todo gratis, sin tarjeta)

- **Render** (render.com) — corre el servidor. Limitación: se duerme tras 15 min
  sin uso; la primera visita después tarda ~30-50 s (la app abre igual al
  instante gracias al service worker, y sincroniza cuando despierta).
- **Upstash** (upstash.com) — guarda los datos (Redis). El plan gratis sobra
  para esta app.
- **GitHub** — donde vive el código para que Render lo despliegue.

## Paso 1 — Upstash (los datos)

1. Cuenta en [upstash.com](https://upstash.com) (entra con Google o GitHub).
2. *Create Database* → tipo **Redis** → nombre `nutracker` → región
   `us-east-1` (cercana a Render Oregon/Ohio, cualquiera sirve) → plan Free.
3. En la pestaña **REST API** de la base copia dos valores:
   - `UPSTASH_REDIS_REST_URL` (https://...upstash.io)
   - `UPSTASH_REDIS_REST_TOKEN`

## Paso 2 — GitHub (el código)

Repo **privado** `nutracker` con el contenido de `D:\Nutracker`.
Claude Code te lo puede hacer con `gh` (el `.gitignore` ya excluye `data.json`).

## Paso 3 — Render (el servidor)

1. Cuenta en [render.com](https://render.com) (entra con GitHub).
2. *New* → *Web Service* → conecta el repo `nutracker`.
3. Render detecta Node solo. Verifica: **Start Command** = `node server.js`,
   **Instance Type** = `Free`.
4. En **Environment Variables** agrega:
   | Variable | Valor |
   |---|---|
   | `NT_PIN` | un PIN compartido con Cris (ej: `4821`) |
   | `UPSTASH_REDIS_REST_URL` | el del paso 1 |
   | `UPSTASH_REDIS_REST_TOKEN` | el del paso 1 |
5. *Deploy Web Service*. Al terminar te da la URL:
   `https://nutracker-XXXX.onrender.com`

## Paso 4 — En los celulares y PC

1. Abrir la URL → ingresar el PIN.
2. Menú del navegador → **"Agregar a pantalla de inicio" / "Instalar app"**
   (con HTTPS la PWA se instala como app de verdad).
3. ⚙️ Ajustes → pegar la API key de IA (Anthropic `sk-ant-…` u OpenAI `sk-…`).
4. Migrar datos locales: en la app local ⚙️ → **Exportar datos**, en la de
   Render ⚙️ → **Importar datos**.

## Paso 5 — Conectar el Garmin Coach

En `D:\Garmin\garmin-coach\GARMIN_COACH_v6.md`, PASO 7.5, cambiar la URL por la
de Render y poner el PIN (dejar `-m 120 --retry 3`: cubre el despertar del
servidor dormido).

## Después de cada cambio de código

`git push` → Render redespliega solo. Los datos no se tocan (viven en Upstash).
