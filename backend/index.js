import express from 'express';
import cors from 'cors';
import { createClient } from 'redis';

// ---------- Connexion Redis ----------
const redis = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379',
  // En cas de Redis down, les commandes echouent immediatement
  // au lieu de hanger jusqu'au timeout HTTP cote client.
  disableOfflineQueue: true,
});
redis.on('error', (e) => console.error('[redis]', e.message));
await redis.connect();

// Le pub/sub Redis necessite une connexion dediee (un client en SUBSCRIBE
// ne peut plus executer de commandes normales).
const subscriber = redis.duplicate();
subscriber.on('error', (e) => console.error('[redis-sub]', e.message));
await subscriber.connect();

// ---------- Modele de donnees Redis ----------
//
//   polls:next_id                  counter   -> prochain id de sondage
//   polls:all                      ZSET      -> { score: timestamp, value: id } (ordre chronologique)
//   poll:<id>                      HASH      -> { question, created_at }
//   poll:<id>:next_option_id       counter   -> prochain id d'option pour ce poll
//   poll:<id>:options              HASH      -> { option_id: label }
//   poll:<id>:counts               HASH      -> { option_id: count }
//   leaderboard:polls              ZSET      -> { score: total_votes, value: id }
//
// Channels pub/sub :
//   poll:<id>:updates              push des compteurs a chaque vote
//   polls:events                   push des creations / votes (vue admin)

const POLLS_ALL = 'polls:all';
const NEXT_POLL_ID = 'polls:next_id';
const POLL_META = (id) => `poll:${id}`;
const POLL_OPTIONS = (id) => `poll:${id}:options`;
const POLL_COUNTS = (id) => `poll:${id}:counts`;
const NEXT_OPTION_ID = (id) => `poll:${id}:next_option_id`;
const LEADERBOARD = 'leaderboard:polls';
const pollChannel = (id) => `poll:${id}:updates`;
const GLOBAL_CHANNEL = 'polls:events';

// Wrapper async pour transformer les rejections en next(err) -> middleware d'erreur.
const ah = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

async function readSnapshot(pollId) {
  const [options, counts] = await Promise.all([
    redis.hGetAll(POLL_OPTIONS(pollId)),
    redis.hGetAll(POLL_COUNTS(pollId)),
  ]);
  return {
    poll_id: pollId,
    options: Object.entries(options)
      .map(([id, label]) => ({
        id: Number(id),
        label,
        votes: Number(counts[id] || 0),
      }))
      .sort((a, b) => a.id - b.id),
  };
}

// ---------- App ----------
const app = express();
app.use(cors());
app.use(express.json());

// Health
app.get('/health', async (req, res) => {
  try {
    await redis.ping();
    res.json({ ok: true, redis: 'up' });
  } catch (e) {
    res.status(503).json({ ok: false, redis: 'down', error: e.message });
  }
});

// Liste des sondages (recents en premier)
app.get('/polls', ah(async (req, res) => {
  const ids = await redis.zRange(POLLS_ALL, 0, -1, { REV: true });
  if (ids.length === 0) return res.json([]);
  const polls = await Promise.all(
    ids.map(async (id) => {
      const meta = await redis.hGetAll(POLL_META(id));
      return meta.question
        ? { id: Number(id), question: meta.question, created_at: meta.created_at }
        : null;
    })
  );
  res.json(polls.filter(Boolean));
}));

// Creation
app.post('/polls', ah(async (req, res) => {
  const { question, options } = req.body || {};
  if (
    typeof question !== 'string' ||
    !question.trim() ||
    !Array.isArray(options) ||
    options.length < 2
  ) {
    return res.status(400).json({ error: 'question + options (>=2) requis' });
  }

  const pollId = await redis.incr(NEXT_POLL_ID);
  const createdAt = new Date().toISOString();

  const optionsHash = {};
  const countsHash = {};
  const inserted = [];
  for (const label of options) {
    const oid = await redis.incr(NEXT_OPTION_ID(pollId));
    const cleanLabel = String(label).trim();
    optionsHash[oid] = cleanLabel;
    countsHash[oid] = '0';
    inserted.push({ id: oid, label: cleanLabel });
  }

  const pipe = redis.multi();
  pipe.hSet(POLL_META(pollId), { question: question.trim(), created_at: createdAt });
  pipe.hSet(POLL_OPTIONS(pollId), optionsHash);
  pipe.hSet(POLL_COUNTS(pollId), countsHash);
  pipe.zAdd(POLLS_ALL, { score: Date.now(), value: String(pollId) });
  pipe.zAdd(LEADERBOARD, { score: 0, value: String(pollId) });
  await pipe.exec();

  await redis.publish(
    GLOBAL_CHANNEL,
    JSON.stringify({
      type: 'poll_created',
      poll: { id: pollId, question: question.trim(), created_at: createdAt },
    })
  );

  res.status(201).json({
    id: pollId,
    question: question.trim(),
    created_at: createdAt,
    options: inserted,
  });
}));

// Detail + compteurs
app.get('/polls/:id', ah(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id invalide' });

  const meta = await redis.hGetAll(POLL_META(id));
  if (!meta.question) return res.status(404).json({ error: 'poll introuvable' });

  const snap = await readSnapshot(id);
  res.json({
    id,
    question: meta.question,
    created_at: meta.created_at,
    options: snap.options,
  });
}));

// Voter
app.post('/polls/:id/vote', ah(async (req, res) => {
  const pollId = Number(req.params.id);
  const optionId = Number(req.body?.option_id);
  if (!Number.isInteger(pollId) || !Number.isInteger(optionId)) {
    return res.status(400).json({ error: 'poll id + option_id requis' });
  }

  const exists = await redis.hExists(POLL_OPTIONS(pollId), String(optionId));
  if (!exists) {
    return res.status(400).json({ error: 'option_id n appartient pas a ce poll' });
  }

  const [liveCount, totalForPoll] = await Promise.all([
    redis.hIncrBy(POLL_COUNTS(pollId), String(optionId), 1),
    redis.zIncrBy(LEADERBOARD, 1, String(pollId)),
  ]);

  const snapshot = await readSnapshot(pollId);
  await redis.publish(pollChannel(pollId), JSON.stringify(snapshot));
  await redis.publish(
    GLOBAL_CHANNEL,
    JSON.stringify({
      type: 'vote_recorded',
      poll_id: pollId,
      poll_total: Number(totalForPoll),
    })
  );

  res.status(201).json({
    live_count: liveCount,
    poll_total: Number(totalForPoll),
  });
}));

// Leaderboard
app.get('/leaderboard', ah(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 100);
  const top = await redis.zRangeWithScores(LEADERBOARD, 0, limit - 1, { REV: true });
  if (top.length === 0) return res.json([]);
  const items = await Promise.all(
    top.map(async (t, rank) => {
      const meta = await redis.hGetAll(POLL_META(t.value));
      return {
        rank: rank + 1,
        poll_id: Number(t.value),
        question: meta.question || '(supprime)',
        total_votes: Number(t.score),
      };
    })
  );
  res.json(items);
}));

// SSE global : vue admin (creations + votes)
app.get('/stream', ah(async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write(`event: hello\ndata: {"ok":true}\n\n`);

  const listener = (msg) => res.write(`data: ${msg}\n\n`);
  await subscriber.subscribe(GLOBAL_CHANNEL, listener);

  const ping = setInterval(() => res.write(`: ping\n\n`), 25000);
  req.on('close', async () => {
    clearInterval(ping);
    try { await subscriber.unsubscribe(GLOBAL_CHANNEL, listener); } catch {}
  });
}));

// SSE par sondage : push des compteurs en temps reel
app.get('/polls/:id/stream', ah(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).end();

  const meta = await redis.hGetAll(POLL_META(id));
  if (!meta.question) return res.status(404).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const snap = await readSnapshot(id);
  res.write(`event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`);

  const channel = pollChannel(id);
  const listener = (msg) => res.write(`event: update\ndata: ${msg}\n\n`);
  await subscriber.subscribe(channel, listener);

  const ping = setInterval(() => res.write(`: ping\n\n`), 25000);
  req.on('close', async () => {
    clearInterval(ping);
    try { await subscriber.unsubscribe(channel, listener); } catch {}
  });
}));

// Middleware d'erreur : attrape toute exception async via ah() et
// renvoie une vraie reponse HTTP au lieu de hanger / crasher.
app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  if (res.headersSent) return next(err);
  res.status(503).json({ error: err.message });
});

// ---------- Start ----------
const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`VoteFlash backend ecoute sur :${PORT}`);
});

async function shutdown() {
  console.log('[shutdown] fermeture des connexions Redis...');
  await subscriber.quit().catch(() => {});
  await redis.quit().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
