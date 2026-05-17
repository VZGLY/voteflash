FROM nginx:1.27-alpine

# Config nginx custom (proxy /api -> backend)
COPY nginx.conf /etc/nginx/conf.d/default.conf

# App statique
COPY index.html app.js /usr/share/nginx/html/

EXPOSE 80

HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD wget -q --spider http://localhost/ || exit 1
