FROM node:20-alpine

WORKDIR /app

# Install deps first (layer cache)
COPY package.json ./
RUN npm install --omit=dev

# Copy source
COPY server.js ./
COPY public/ ./public/

# Data directory (will be overridden by volume mount)
RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "server.js"]
