// VoteFlash - frontend vanilla JS
// L'app est servie par nginx qui proxifie /api -> backend (cf nginx.conf).
const API = '/api';

// ---------- Router minimal ----------
const params = new URLSearchParams(window.location.search);
const pollId = params.get('poll');

if (pollId) {
  document.getElementById('view-admin').classList.add('hidden');
  document.getElementById('view-vote').classList.remove('hidden');
  initVoteView(Number(pollId));
} else {
  initAdminView();
}

// ---------- Health pill ----------
async function refreshHealth() {
  const text = document.getElementById('health-text');
  try {
    const r = await fetch(`${API}/health`);
    const j = await r.json();
    text.textContent = `redis ${j.redis || '?'}`;
  } catch {
    text.textContent = 'backend hors ligne';
  }
}
refreshHealth();
setInterval(refreshHealth, 5000);

// ============================================================
//                       VUE ADMIN
// ============================================================
function initAdminView() {
  // Ajouter une option
  document.getElementById('add-option').addEventListener('click', () => {
    const wrap = document.getElementById('f-options');
    const n = wrap.children.length + 1;
    const input = document.createElement('input');
    input.className = 'opt w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-2 outline-none placeholder:text-slate-500 focus:border-brand-500';
    input.placeholder = `Option ${n}`;
    wrap.appendChild(input);
  });

  // Creer un sondage
  document.getElementById('form-create').addEventListener('submit', async (e) => {
    e.preventDefault();
    const question = document.getElementById('f-question').value.trim();
    const options = [...document.querySelectorAll('.opt')]
      .map((i) => i.value.trim())
      .filter(Boolean);
    if (!question || options.length < 2) {
      alert('Une question + au moins 2 options non vides');
      return;
    }
    const r = await fetch(`${API}/polls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, options }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      alert('Erreur : ' + (err.error || r.status));
      return;
    }
    e.target.reset();
    // remet 2 inputs vides
    const wrap = document.getElementById('f-options');
    wrap.innerHTML =
      '<input class="opt w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-2 outline-none placeholder:text-slate-500 focus:border-brand-500" placeholder="Option 1" />' +
      '<input class="opt w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-2 outline-none placeholder:text-slate-500 focus:border-brand-500" placeholder="Option 2" />';
    await Promise.all([loadPolls(), loadLeaderboard()]);
  });

  document.getElementById('refresh-polls').addEventListener('click', () => {
    loadPolls();
    loadLeaderboard();
  });

  loadPolls();
  loadLeaderboard();

  // SSE global : push instantane lors des creations et des votes (leaderboard)
  const ev = new EventSource(`${API}/stream`);
  ev.onmessage = (e) => {
    let payload;
    try {
      payload = JSON.parse(e.data);
    } catch {
      return;
    }
    if (payload.type === 'poll_created') {
      loadPolls();
    } else if (payload.type === 'vote_recorded') {
      loadLeaderboard();
    }
  };
  ev.onerror = () => {
    // EventSource se reconnecte automatiquement
  };
}

async function loadPolls() {
  const ul = document.getElementById('list-polls');
  const r = await fetch(`${API}/polls`);
  const polls = await r.json();
  if (polls.length === 0) {
    ul.innerHTML = '<li class="text-sm text-slate-500">Aucun sondage. Creez le premier.</li>';
    return;
  }
  ul.innerHTML = polls
    .map(
      (p) => `
      <li>
        <a href="?poll=${p.id}" class="group flex items-center justify-between rounded-lg border border-slate-800 bg-slate-950 px-4 py-3 hover:border-brand-500 hover:bg-slate-900">
          <span>
            <span class="text-xs text-slate-500">#${p.id}</span>
            <span class="ml-2 font-medium">${escapeHtml(p.question)}</span>
          </span>
          <span class="text-sm text-slate-500 group-hover:text-brand-500">voter &rarr;</span>
        </a>
      </li>`
    )
    .join('');
}

async function loadLeaderboard() {
  const ol = document.getElementById('list-leaderboard');
  try {
    const r = await fetch(`${API}/leaderboard?limit=5`);
    if (!r.ok) {
      ol.innerHTML = '<li class="text-amber-500">temporairement indisponible</li>';
      return;
    }
    const top = await r.json();
    if (!Array.isArray(top) || top.length === 0) {
      ol.innerHTML = '<li class="text-slate-500">aucune donnee</li>';
      return;
    }
    ol.innerHTML = top
      .map(
        (t) => `
        <li class="flex items-center justify-between gap-2">
          <span class="flex items-center gap-2 truncate">
            <span class="grid h-5 w-5 place-items-center rounded bg-slate-800 text-xs">${t.rank}</span>
            <a href="?poll=${t.poll_id}" class="truncate hover:text-brand-500">${escapeHtml(t.question)}</a>
          </span>
          <span class="text-slate-400">${t.total_votes}</span>
        </li>`
      )
      .join('');
  } catch {
    ol.innerHTML = '<li class="text-amber-500">temporairement indisponible</li>';
  }
}

// ============================================================
//                       VUE VOTE
// ============================================================
async function initVoteView(id) {
  document.getElementById('v-id').textContent = id;

  // Premier load pour avoir question + options
  const r = await fetch(`${API}/polls/${id}`);
  if (!r.ok) {
    document.getElementById('v-question').textContent = 'Sondage introuvable';
    return;
  }
  const poll = await r.json();
  document.getElementById('v-question').textContent = poll.question;
  renderOptions(poll.options);

  // Connexion SSE : push instantane des compteurs a chaque vote
  // (le serveur s'abonne a Redis Pub/Sub et nous transmet)
  const ev = new EventSource(`${API}/polls/${id}/stream`);
  ev.addEventListener('snapshot', (e) => renderOptions(JSON.parse(e.data).options));
  ev.addEventListener('update', (e) => renderOptions(JSON.parse(e.data).options));
  ev.onerror = () => {
    // EventSource se reconnecte tout seul -> on ne fait rien
  };
}

function renderOptions(options) {
  const wrap = document.getElementById('v-options');
  const total = options.reduce((s, o) => s + o.votes, 0);
  document.getElementById('v-total').textContent = total;

  // Construit ou met a jour
  if (wrap.children.length !== options.length) {
    wrap.innerHTML = options
      .map(
        (o) => `
        <button data-id="${o.id}" class="opt-btn w-full overflow-hidden rounded-xl border border-slate-800 bg-slate-900/40 p-4 text-left transition hover:border-brand-500">
          <div class="mb-2 flex items-center justify-between">
            <span class="font-medium">${escapeHtml(o.label)}</span>
            <span class="text-sm tabular-nums text-slate-400"><span class="o-count">0</span> votes (<span class="o-pct">0</span>%)</span>
          </div>
          <div class="h-2 w-full rounded-full bg-slate-800">
            <div class="bar h-full rounded-full bg-gradient-to-r from-brand-500 to-cyan-400" style="width:0%"></div>
          </div>
        </button>`
      )
      .join('');

    // Bind clicks
    const pollId = document.getElementById('v-id').textContent;
    wrap.querySelectorAll('.opt-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const optionId = Number(btn.dataset.id);
        btn.disabled = true;
        await fetch(`${API}/polls/${pollId}/vote`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ option_id: optionId }),
        });
        btn.disabled = false;
        // Pas besoin de re-fetch : la SSE va pousser le nouvel etat
      });
    });
  }

  // Mise a jour des chiffres + barres
  [...wrap.children].forEach((btn, i) => {
    const o = options[i];
    const pct = total > 0 ? Math.round((o.votes / total) * 100) : 0;
    btn.querySelector('.o-count').textContent = o.votes;
    btn.querySelector('.o-pct').textContent = pct;
    btn.querySelector('.bar').style.width = pct + '%';
  });
}

// ---------- Utils ----------
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
