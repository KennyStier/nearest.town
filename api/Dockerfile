# Pin to a digest for reproducible builds if you like:
#   docker pull node:24-alpine && docker inspect --format '{{index .RepoDigests 0}}' node:24-alpine
FROM node:24-alpine
WORKDIR /app
COPY --chown=root:root package.json nearest.mjs server.mjs ./
COPY --chown=root:root data ./data
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0
EXPOSE 8080
# Runs as the unprivileged "node" user; app files stay root-owned and read-only to it.
USER node
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/health >/dev/null || exit 1
CMD ["node", "server.mjs"]
