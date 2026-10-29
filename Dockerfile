FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install --global npm@10.9.9 \
    && npm ci --omit=dev

COPY . .

ENV NODE_ENV=production \
    PORT=3000

EXPOSE 3000

USER node

CMD ["npm", "start"]
