import Fastify from 'fastify';
import path from 'path';
import fastifyStatic from '@fastify/static';
import dotenv from 'dotenv';
import archiveRoutes from './routes/archive.js';

dotenv.config();

const fastify = Fastify({ logger: true });

const __dirname = path.resolve();
const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

// serve static UI
fastify.register(fastifyStatic, {
  root: path.join(__dirname, 'public'),
});

// API routes
fastify.register(archiveRoutes, { prefix: '/api', dataDir: DATA_DIR });

// fallback to index.html
fastify.setNotFoundHandler((req, reply) => {
  return reply.sendFile('index.html');
});

fastify.listen({ port: PORT, host: '0.0.0.0' }).catch(err => {
  fastify.log.error(err);
  process.exit(1);
});