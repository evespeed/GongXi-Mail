# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies for server
COPY server/package*.json ./server/
RUN cd server && npm install

# Copy source code
COPY server ./server

# Generate Prisma client
RUN cd server && npx prisma generate

# Build server
RUN cd server && npm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

# Copy server
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/server/node_modules ./server/node_modules
COPY --from=builder /app/server/package.json ./server/
COPY --from=builder /app/server/prisma ./server/prisma

# Copy frontend build to public
COPY web/dist ./public

# Set working directory to server
WORKDIR /app/server

# Run database migrations and start server
CMD ["sh", "-c", "npx prisma db push --skip-generate && node dist/index.js"]

EXPOSE 3000
