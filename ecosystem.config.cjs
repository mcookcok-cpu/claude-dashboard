module.exports = {
  apps: [{
    name: 'claude-dashboard',
    script: 'server.mjs',
    cwd: __dirname,
    env: { PORT: 2200, NODE_ENV: 'production', PM2_BIN: '/usr/local/bin/pm2' },
    max_memory_restart: '150M',
    autorestart: true
  }]
};
