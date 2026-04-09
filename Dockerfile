FROM node:20-slim

WORKDIR /app

COPY package*.json ./
COPY patches/ ./patches/
RUN npm install

COPY . .

EXPOSE 3000

CMD ["node", "index.js"]