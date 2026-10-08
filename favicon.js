// Browsers generally freeze SVG animation in favicons. Swap small PNG frames instead.
(() => {
  const icon = document.getElementById('windTurbineIcon');
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 32;
  const ctx = canvas.getContext('2d');
  if (!icon || !ctx) return;
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const frames = Array.from({ length: 12 }, (_, frame) => {
    ctx.fillStyle = '#07080f';
    ctx.fillRect(0, 0, 32, 32);
    ctx.strokeStyle = '#5dffa8';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(16, 13); ctx.lineTo(16, 28); ctx.stroke();
    for (let blade = 0; blade < 3; blade++) {
      const angle = frame * Math.PI * 2 / 36 + blade * Math.PI * 2 / 3;
      ctx.beginPath(); ctx.moveTo(16, 13);
      ctx.lineTo(16 + Math.cos(angle) * 11, 13 + Math.sin(angle) * 11); ctx.stroke();
    }
    return canvas.toDataURL('image/png');
  });
  let timer, frame = 0;
  function update() {
    icon.type = 'image/png';
    icon.href = frames[frame++ % frames.length];
  }
  function sync() {
    clearInterval(timer);
    if (motion.matches) { frame = 0; update(); }
    else if (!document.hidden) { update(); timer = setInterval(update, 150); }
  }
  document.addEventListener('visibilitychange', sync);
  motion.addEventListener('change', sync);
  addEventListener('pagehide', () => clearInterval(timer));
  addEventListener('pageshow', sync);
  sync();
})();
