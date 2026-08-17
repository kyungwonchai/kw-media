import express from 'express';
import { execSync, spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 10150;

const MEDIA_DIR = '/home/kw/kmov';
const JELLYFIN_CONTAINER = 'my-jellyfin';
const QBITTORRENT_CONTAINER = 'qbittorrent';
const VPN_SCRIPT = '/home/kw/.local/bin/kw-vpn';
const PRIVATE_LINKS_FILE = '/home/kw/.kwsoft-private-links.json';

app.use(express.json());

function loadPrivateLinks() {
  try {
    if (existsSync(PRIVATE_LINKS_FILE)) {
      return JSON.parse(readFileSync(PRIVATE_LINKS_FILE, 'utf8'));
    }
  } catch {}
  return [];
}

function savePrivateLinks(links) {
  try {
    writeFileSync(PRIVATE_LINKS_FILE, JSON.stringify(links, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save private links:', e);
  }
}

function isContainerRunning(name) {
  try {
    const out = execSync(
      `podman inspect --format '{{.State.Running}}' ${name} 2>/dev/null`,
      { encoding: 'utf8' },
    ).trim();
    return out === 'true';
  } catch {
    return false;
  }
}

function isVpnConnected() {
  try {
    const out = execSync('ip -brief addr show dev tun0 2>/dev/null', {
      encoding: 'utf8',
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

function getMediaStats() {
  try {
    const dfOut = execSync(`df -h ${MEDIA_DIR} 2>/dev/null | tail -n 1`, {
      encoding: 'utf8',
    }).trim();
    const parts = dfOut.split(/\s+/);
    return {
      size: parts[1] || '0G',
      used: parts[2] || '0G',
      avail: parts[3] || '0G',
      percent: parts[4] || '0%',
      mount: parts[5] || MEDIA_DIR,
    };
  } catch {
    return { size: 'N/A', used: 'N/A', avail: 'N/A', percent: '0%', mount: MEDIA_DIR };
  }
}

function ensureJellyfinContainer() {
  try {
    execSync(`podman inspect ${JELLYFIN_CONTAINER}`, { stdio: 'ignore' });
  } catch {
    execSync(
      `podman run -d --name ${JELLYFIN_CONTAINER} --network host ` +
      `-v ${MEDIA_DIR}:/media:Z -v /home/kw/.config/jellyfin:/config:Z ` +
      `docker.io/jellyfin/jellyfin:latest`,
      { encoding: 'utf8' }
    );
  }
}

function ensureQbittorrentContainer() {
  try {
    execSync(`podman inspect ${QBITTORRENT_CONTAINER}`, { stdio: 'ignore' });
  } catch {
    execSync(
      `podman run -d --name ${QBITTORRENT_CONTAINER} ` +
      `-p 8080:8080 -p 6881:6881 -p 6881:6881/udp ` +
      `-e PUID=1000 -e PGID=1000 ` +
      `-v /home/kw/.config/qbittorrent:/config:Z ` +
      `-v ${MEDIA_DIR}/videos:/downloads:Z ` +
      `docker.io/linuxserver/qbittorrent:latest`,
      { encoding: 'utf8' }
    );
  }
}

// API Routes
const apiRouter = express.Router();

apiRouter.get('/status', (req, res) => {
  res.json({
    jellyfinRunning: isContainerRunning(JELLYFIN_CONTAINER),
    qbittorrentRunning: isContainerRunning(QBITTORRENT_CONTAINER),
    vpnConnected: isVpnConnected(),
    mediaDir: MEDIA_DIR,
    disk: getMediaStats(),
  });
});

apiRouter.post('/vpn/:action', (req, res) => {
  const { action } = req.params;
  try {
    if (action === 'connect') {
      execSync(`sudo ${VPN_SCRIPT} up`, { encoding: 'utf8' });
    } else if (action === 'disconnect') {
      execSync(`sudo ${VPN_SCRIPT} down`, { encoding: 'utf8' });
    } else {
      return res.status(400).json({ error: 'Invalid action' });
    }
    res.json({ ok: true, vpnConnected: isVpnConnected() });
  } catch (e) {
    const msg = e.message?.includes('sudo')
      ? 'VPN 켜려면 터미널에서: sudo tee /etc/sudoers.d/kw-vpn <<< \'kw ALL=(ALL) NOPASSWD: /home/kw/.local/bin/kw-vpn\' && sudo chmod 440 /etc/sudoers.d/kw-vpn'
      : e.message;
    res.status(500).json({ error: msg });
  }
});

apiRouter.post('/jellyfin/:action', (req, res) => {
  const { action } = req.params;
  try {
    if (action === 'start') {
      ensureJellyfinContainer();
      execSync(`podman start ${JELLYFIN_CONTAINER}`, { encoding: 'utf8' });
    } else if (action === 'stop') {
      execSync(`podman stop ${JELLYFIN_CONTAINER}`, { encoding: 'utf8' });
    } else if (action === 'open') {
      spawn('google-chrome', ['--incognito', 'http://localhost:8096'], { detached: true, stdio: 'ignore' }).unref();
    } else {
      return res.status(400).json({ error: 'Invalid action' });
    }
    res.json({ ok: true, jellyfinRunning: isContainerRunning(JELLYFIN_CONTAINER) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

apiRouter.post('/qbittorrent/:action', (req, res) => {
  const { action } = req.params;
  try {
    if (action === 'start') {
      ensureQbittorrentContainer();
      execSync(`podman start ${QBITTORRENT_CONTAINER}`, { encoding: 'utf8' });
    } else if (action === 'stop') {
      execSync(`podman stop ${QBITTORRENT_CONTAINER}`, { encoding: 'utf8' });
    } else {
      return res.status(400).json({ error: 'Invalid action' });
    }
    res.json({ ok: true, qbittorrentRunning: isContainerRunning(QBITTORRENT_CONTAINER) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

apiRouter.get('/links', (req, res) => {
  res.json(loadPrivateLinks());
});

apiRouter.post('/links', (req, res) => {
  const links = req.body;
  if (!Array.isArray(links)) return res.status(400).json({ error: 'Array required' });
  savePrivateLinks(links);
  res.json({ ok: true });
});

// Dual Routing support: /api and /kw-media/api
app.use('/api', apiRouter);
app.use('/kw-media/api', apiRouter);

// Static files support: / and /kw-media
app.use('/kw-media', express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🎬 KW-Media Server running on http://0.0.0.0:${PORT} & /kw-media/`);
});
