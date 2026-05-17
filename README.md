# VoteFlash

Mini-app de sondages en temps reel.

Stack : Node.js + Express, Redis, HTML/JS vanilla + nginx.

## Images Docker

Publiees sur Docker Hub :

- Backend : <https://hub.docker.com/r/vaozgeely/voteflash-backend>
- Frontend : <https://hub.docker.com/r/vaozgeely/voteflash-frontend>

```bash
docker pull vaozgeely/voteflash-backend:1.0.0
docker pull vaozgeely/voteflash-frontend:1.0.0
```

## Architecture

```
[navigateur]
     |
   :8080
     |
[frontend (nginx)] --/api--> [backend (Node)] --> [redis]
   sert l'app statique           API REST + SSE       stockage + pub/sub
```

- Le **frontend** sert l'app statique et proxifie `/api/*` vers le backend.
- Le **backend** est l'unique consommateur de Redis.
- Redis stocke les sondages, les compteurs de votes et fait le pub/sub temps reel.
- Persistance Redis via AOF -> les donnees survivent au redemarrage.
- Seul le frontend est expose sur l'hote (port 8080).

## Demarrage

Pre-requis : Docker + Docker Compose.

```bash
docker compose up -d --build
```

Acces : <http://localhost:8080>

Arret :

```bash
docker compose down       # garde les donnees Redis
docker compose down -v    # supprime aussi les donnees
```

## Utilisation

### Page d'accueil
- Creer un sondage (question + 2 options ou plus)
- Liste des sondages (cliquer pour aller voter)
- Top 5 des sondages les plus actifs

La page est **live** : un nouveau sondage cree ou un vote dans un autre onglet
fait bouger la liste / le leaderboard sans rafraichir.

### Vue vote (`?poll=N`)
- Affiche la question + les options
- Cliquer sur une option vote
- Les barres bougent **instantanement** via SSE + Redis Pub/Sub

Demo : ouvrir 2 onglets sur la meme URL `?poll=N`, voter dans l'un -> l'autre bouge sous 50 ms.

## Endpoints

| Methode | Route | Description |
|---------|-------|-------------|
| GET  | `/health` | Etat du backend + Redis |
| GET  | `/polls` | Liste des sondages |
| POST | `/polls` | Cree un sondage `{question, options[]}` |
| GET  | `/polls/:id` | Detail + compteurs |
| POST | `/polls/:id/vote` | Voter `{option_id}` |
| GET  | `/polls/:id/stream` | SSE : push des compteurs du sondage |
| GET  | `/leaderboard?limit=N` | Top sondages |
| GET  | `/stream` | SSE global : `poll_created`, `vote_recorded` |

En docker compose, accessibles via le prefixe `/api/` cote nginx.

## Modele de donnees Redis

```
polls:next_id              counter   prochain id de sondage
polls:all                  ZSET      { timestamp -> id }     (ordre chronologique)
poll:<id>                  HASH      { question, created_at }
poll:<id>:options          HASH      { option_id -> label }
poll:<id>:counts           HASH      { option_id -> count }
poll:<id>:next_option_id   counter   prochain id d'option pour ce poll
leaderboard:polls          ZSET      { total_votes -> id }
```

Channels pub/sub :
- `poll:<id>:updates` : push des compteurs a chaque vote sur ce sondage
- `polls:events`      : events globaux (creations, votes) pour la vue admin

## Structure

```
voteflash/
|-- docker-compose.yml
|-- backend/
|   |-- Dockerfile
|   |-- package.json
|   |-- index.js
|-- frontend/
    |-- Dockerfile
    |-- nginx.conf
    |-- index.html
    |-- app.js
```

## Debug

```bash
# Logs
docker compose logs -f backend
docker compose logs -f redis

# Console Redis
docker compose exec redis redis-cli
> KEYS *
> HGETALL poll:1
> ZREVRANGE leaderboard:polls 0 -1 WITHSCORES

# Reset complet
docker compose down -v && docker compose up -d --build
```
