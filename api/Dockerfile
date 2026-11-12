FROM node:24-alpine
WORKDIR /app
COPY package.json nearest.mjs server.mjs ./
COPY data ./data
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "server.mjs"]
