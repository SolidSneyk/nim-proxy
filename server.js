const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json({ limit: '10mb' }));

// Registro simple de peticiones (aparece en la pestaña Logs gratuita de Render).
// No muestra la API key ni el contenido de los mensajes.
app.use((req, res, next) => {
  const model = req.body && req.body.model ? ` model=${req.body.model}` : '';
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}${model}`);
  res.on('finish', () => {
    console.log(`  -> ${req.method} ${req.url} respondió ${res.statusCode}`);
  });
  next();
});

// CORS middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  // Acepta cualquier cabecera extra que el navegador pida en el preflight
  res.header(
    'Access-Control-Allow-Headers',
    req.headers['access-control-request-headers'] || 'Content-Type, Authorization'
  );
  res.header('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// Lista de modelos que aparecerán en /v1/models (y en el desplegable de Chub).
// IMPORTANTE: los IDs deben coincidir EXACTO con build.nvidia.com.
// Si algún ID da error 404, corrígelo copiándolo del catálogo de NVIDIA.
const MODEL_IDS = [
  'moonshotai/kimi-k3.1-pro',
  'deepseek-ai/deepseek-v4.1-flash',
  'deepseek-ai/deepseek-v4-pro',
  'meta/llama-3.1-405b-instruct',
  'meta/llama-3.1-70b-instruct',
  'meta/llama-3.1-8b-instruct',
  'mistralai/mixtral-8x7b-instruct-v0.1'
];

// Modelo de respaldo: se usa si el cliente (por ejemplo Chub) manda un nombre
// que no es un ID de NVIDIA (sin "/"), como "gpt-4o".
// Se puede cambiar con la variable de entorno DEFAULT_MODEL en Render.
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'moonshotai/kimi-k3.1-pro';

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'NVIDIA NIM to OpenAI API Proxy',
    endpoints: {
      chat: '/v1/chat/completions',
      models: '/v1/models'
    }
  });
});

// Models endpoint
app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: MODEL_IDS.map((id) => ({
      id,
      object: 'model',
      created: 1686935002,
      owned_by: 'nvidia'
    }))
  });
});

// Main chat completions endpoint
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: { message: 'Missing or invalid Authorization header', type: 'invalid_request_error' }
      });
    }

    const apiKey = authHeader.substring(7);
    const { messages, model, stream, temperature, max_tokens, top_p, frequency_penalty, presence_penalty } = req.body;

    // Validate required fields
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({
        error: { message: 'Messages array is required', type: 'invalid_request_error' }
      });
    }

    // Si el modelo trae "/" se respeta (ID real de NVIDIA).
    // Si no, se usa el modelo de respaldo.
    const nimModel = (model && model.includes('/')) ? model : DEFAULT_MODEL;

    // Build NVIDIA NIM request
    const nimRequest = {
      model: nimModel,
      messages: messages,
      temperature: temperature !== undefined ? temperature : 0.7,
      top_p: top_p !== undefined ? top_p : 1,
      max_tokens: max_tokens !== undefined ? max_tokens : 1024,
      stream: stream || false
    };

    // Add optional parameters if provided
    if (frequency_penalty !== undefined) {
      nimRequest.frequency_penalty = frequency_penalty;
    }
    if (presence_penalty !== undefined) {
      nimRequest.presence_penalty = presence_penalty;
    }

    const nimUrl = 'https://integrate.api.nvidia.com/v1/chat/completions';

    // Resumen para depurar (sin mostrar el contenido de los mensajes ni la key)
    console.log(
      '  params:',
      JSON.stringify({
        model: nimModel,
        temperature: nimRequest.temperature,
        top_p: nimRequest.top_p,
        max_tokens: nimRequest.max_tokens,
        stream: nimRequest.stream,
        n_messages: messages.length,
        roles: messages.map((m) => m.role).join(',')
      })
    );

    if (stream) {
      // Streaming response
      const response = await axios.post(nimUrl, nimRequest, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream'
        },
        responseType: 'stream'
      });

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      response.data.pipe(res);
    } else {
      // Non-streaming response
      const response = await axios.post(nimUrl, nimRequest, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        }
      });

      // Return NVIDIA NIM response as-is (already in OpenAI format)
      res.json(response.data);
    }
  } catch (error) {
    console.error('Error proxying request:', error.message);

    if (error.response) {
      // Forward NVIDIA NIM error response
      // (si la respuesta es un stream, se lee antes de reenviarla)
      const status = error.response.status;
      const data = error.response.data;
      if (data && typeof data.pipe !== 'function') {
        console.error('NVIDIA respondió con error:', status, JSON.stringify(data).slice(0, 1500));
      }
      if (data && typeof data.pipe === 'function') {
        let body = '';
        data.on('data', (chunk) => { body += chunk.toString(); });
        data.on('end', () => {
          console.error('NVIDIA respondió con error:', status, body.slice(0, 1500));
          try {
            res.status(status).json(JSON.parse(body));
          } catch (e) {
            res.status(status).json({ error: { message: body || 'Upstream error', type: 'upstream_error' } });
          }
        });
        return;
      }
      return res.status(status).json(data);
    }

    // Generic error response
    res.status(500).json({
      error: {
        message: error.message || 'Internal server error',
        type: 'server_error'
      }
    });
  }
});

// Completions endpoint (legacy, redirects to chat completions)
app.post('/v1/completions', async (req, res) => {
  try {
    const { prompt, ...otherParams } = req.body;

    // Convert prompt to messages format
    const messages = [{ role: 'user', content: prompt }];

    // Forward to chat completions endpoint
    req.body = {
      messages,
      ...otherParams
    };

    return app._router.handle(
      { ...req, url: '/v1/chat/completions', method: 'POST' },
      res
    );
  } catch (error) {
    res.status(500).json({
      error: {
        message: error.message || 'Internal server error',
        type: 'server_error'
      }
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: {
      message: 'Internal server error',
      type: 'server_error'
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`NVIDIA NIM Proxy Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/`);
  console.log(`Chat endpoint: http://localhost:${PORT}/v1/chat/completions`);
});
