# --- Stage 1 : dependances ---
# Cache layer dedie pour ne re-installer que si package.json change
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- Stage 2 : image finale ---
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

# Recopie des node_modules depuis le stage deps (proprietaire = node)
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json index.js ./

USER node
EXPOSE 3000

# Health check natif (Node 20 a fetch global)
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "index.js"]
