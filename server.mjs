import express from 'express';
import { execSync, spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, createReadStream } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 10150;

const MEDIA_ROOTS = {
  downloads: { name: '📥 다운로드 폴더 (Downloads)', path: '/home/kw/Downloads' },
  torrents: { name: '💾 토렌트 영상함', path: '/home/kw/kmov/videos' },
  vjjj: { name: '🔥 액션', path: '/home/kw/mysecret/vjjj', protected: true },
  personal: { name: '📂 개인영상/음악', path: '/home/kw/mysecret/personal' }
};

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
    const dfOut = execSync(`df -h /home/kw/kmov /home/kw/mysecret 2>/dev/null | tail -n 1`, {
      encoding: 'utf8',
    }).trim();
    const parts = dfOut.split(/\s+/);
    return {
      size: parts[1] || '0G',
      used: parts[2] || '0G',
      avail: parts[3] || '0G',
      percent: parts[4] || '0%',
      mount: '/home (NVMe)',
    };
  } catch {
    return { size: 'N/A', used: 'N/A', avail: 'N/A', percent: '0%', mount: '/home' };
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
      `-v /home/kw/kmov/videos:/downloads:Z ` +
      `docker.io/linuxserver/qbittorrent:latest`,
      { encoding: 'utf8' }
    );
  }
}

// Media file scanning helper
const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.avi', '.mov', '.webm', '.wmv', '.flv', '.m4v', '.ts', '.mp3', '.m4a', '.flac', '.wav']);

function scanDirectory(basePath, currentRel = '') {
  const dirPath = path.join(basePath, currentRel);
  if (!existsSync(dirPath)) return [];
  
  let items = [];
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const relPath = currentRel ? `${currentRel}/${ent.name}` : ent.name;
      const fullPath = path.join(basePath, relPath);
      
      let isDir = false;
      let isFile = false;
      let size = 0;
      let mtime = 0;

      try {
        const st = statSync(fullPath);
        isDir = st.isDirectory();
        isFile = st.isFile();
        size = st.size;
        mtime = st.mtimeMs;
      } catch {
        continue;
      }

      if (isDir) {
        items.push({
          name: ent.name,
          relPath,
          isDir: true,
          ext: ''
        });
      } else if (isFile) {
        const ext = path.extname(ent.name).toLowerCase();
        if (VIDEO_EXTS.has(ext)) {
          items.push({
            name: ent.name,
            relPath,
            isDir: false,
            ext,
            size,
            mtime
          });
        }
      }
    }
  } catch (e) {
    console.error('Scan error:', e);
  }
  
  items.sort((a, b) => {
    if (a.isDir && !b.isDir) return -1;
    if (!a.isDir && b.isDir) return 1;
    return a.name.localeCompare(b.name);
  });
  return items;
}

// API Routes
const apiRouter = express.Router();

apiRouter.get('/status', (req, res) => {
  res.json({
    qbittorrentRunning: isContainerRunning(QBITTORRENT_CONTAINER),
    vpnConnected: isVpnConnected(),
    disk: getMediaStats(),
    folders: Object.keys(MEDIA_ROOTS).map(k => ({ key: k, name: MEDIA_ROOTS[k].name, path: MEDIA_ROOTS[k].path }))
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

// Media Files Listing API
apiRouter.get('/media/list', (req, res) => {
  const { folder, subpath = '' } = req.query;
  const root = MEDIA_ROOTS[folder];
  if (!root) return res.status(404).json({ error: 'Folder not found' });
  
  const cleanSub = path.normalize(subpath).replace(/^(\.\.[\/\\])+/, '');
  const items = scanDirectory(root.path, cleanSub);
  res.json({
    folder,
    folderName: root.name,
    subpath: cleanSub,
    items
  });
});

// Video Streaming API (Supports full Range Seeking / Native Fast Scrubbing & AAC Fallback)
apiRouter.get('/media/stream', (req, res) => {
  const { folder, file, transcode } = req.query;
  const root = MEDIA_ROOTS[folder];
  if (!root) return res.status(404).send('Folder not found');

  const cleanFile = path.normalize(file).replace(/^(\.\.[\/\\])+/, '');
  const fullPath = path.join(root.path, cleanFile);

  if (!existsSync(fullPath)) {
    return res.status(404).send('File not found');
  }

  const stat = statSync(fullPath);
  const fileSize = stat.size;
  const ext = path.extname(cleanFile).toLowerCase();

  // If transcode is requested, use ffmpeg with fast seeking
  if (transcode === '1') {
    const startTime = parseFloat(req.query.start) || 0;
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'none');

    const ffmpegArgs = [
      '-ss', String(startTime),
      '-i', fullPath,
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ac', '2',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof+faststart',
      '-f', 'mp4',
      'pipe:1'
    ];

    const ffmpegBin = existsSync('/home/kw/.local/bin/kw-ffmpeg') ? '/home/kw/.local/bin/kw-ffmpeg' : 'ffmpeg';
    const ffmpeg = spawn(ffmpegBin, ffmpegArgs);
    ffmpeg.stdout.pipe(res);

    ffmpeg.stderr.on('data', (d) => {
      // debug logging
    });

    req.on('close', () => {
      ffmpeg.kill('SIGKILL');
    });

    ffmpeg.on('error', (err) => {
      console.error('FFmpeg process error:', err);
      if (!res.headersSent) res.status(500).send('Streaming error');
    });
    return;
  }

  // Standard Range streaming
  const range = req.headers.range;
  const mimeTypes = {
    '.mp4': 'video/mp4',
    '.m4v': 'video/mp4',
    '.webm': 'video/webm',
    '.mkv': 'video/mp4',
    '.avi': 'video/x-msvideo',
    '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.flac': 'audio/flac',
    '.wav': 'audio/wav'
  };
  const contentType = mimeTypes[ext] || 'video/mp4';

  if (range) {
    const match = range.match(/bytes=(\d*)-(\d*)/);
    if (match) {
      const start = match[1] ? parseInt(match[1], 10) : 0;
      const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;

      if (start >= fileSize || end >= fileSize || start > end) {
        res.status(416).setHeader('Content-Range', `bytes */${fileSize}`).end();
        return;
      }

      const chunksize = (end - start) + 1;
      const fileStream = createReadStream(fullPath, { start, end });
      const head = {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': contentType,
      };

      res.writeHead(206, head);
      fileStream.pipe(res);
      return;
    }
  }

  const head = {
    'Content-Length': fileSize,
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
  };
  res.writeHead(200, head);
  createReadStream(fullPath).pipe(res);
});

// File Download API (Forces browser file download with original or custom filename)
apiRouter.get('/media/download', (req, res) => {
  const { folder, file } = req.query;
  const root = MEDIA_ROOTS[folder];
  if (!root) return res.status(404).send('Folder not found');

  const cleanFile = path.normalize(file).replace(/^(\.\.[\/\\])+/, '');
  const fullPath = path.join(root.path, cleanFile);

  if (!existsSync(fullPath)) {
    return res.status(404).send('File not found');
  }

  const filename = path.basename(fullPath);
  res.download(fullPath, filename, (err) => {
    if (err && !res.headersSent) {
      console.error('Download error:', err);
      res.status(500).send('Download failed');
    }
  });
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
