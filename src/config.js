require('dotenv').config({ quiet: true });

const config = {
  apiKey: process.env.DEEPSEEKER_API_KEY || 'dseeker',
  adminUser: process.env.DEEPSEEKER_ADMIN_USER || 'admin',
  adminPassword: process.env.DEEPSEEKER_ADMIN_PASSWORD || 'admin',
  host: process.env.HOST || '127.0.0.1',
  port: parseInt(process.env.PORT || '4000', 10),
  dbPath: process.env.DB_PATH || 'deeperseeker.db',
  sessionTtlMs: 7 * 24 * 3600 * 1000,
};

module.exports = config;
