FROM node:20-alpine
WORKDIR /app

# Instala OpenSSL (necessário pro Prisma no Alpine)
RUN apk add --no-cache openssl

COPY package*.json ./
RUN npm install --production

# Copia TUDO antes de gerar o Prisma
COPY . .

RUN npx prisma generate
RUN mkdir -p public/uploads

EXPOSE 3000
CMD ["sh", "-c", "npx prisma db push && node src/server.js"]
