FROM node:20-alpine
WORKDIR /app

RUN apk add --no-cache openssl

COPY package*.json ./
RUN npm install --production

COPY . .

RUN npx prisma generate
RUN mkdir -p public/uploads data

EXPOSE 3000
CMD ["sh", "-c", "npx prisma db push && node src/server.js"]
