const waveforms = document.querySelectorAll("[data-waveform]");

waveforms.forEach((waveform, waveformIndex) => {
  const count = waveform.closest(".strip-track") ? 54 : 96;
  for (let index = 0; index < count; index += 1) {
    const bar = document.createElement("i");
    const envelope = Math.sin((index / Math.max(1, count - 1)) * Math.PI);
    const rhythm = Math.abs(Math.sin(index * 1.71 + waveformIndex * 2.3));
    const scale = 0.12 + envelope * (0.3 + rhythm * 0.7);
    bar.className = "wave-bar";
    bar.style.setProperty("--scale", scale.toFixed(3));
    bar.style.setProperty("--delay", `${(-index * 0.027).toFixed(3)}s`);
    waveform.appendChild(bar);
  }
});

const observer = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (!entry.isIntersecting) return;
    entry.target.classList.add("visible");
    observer.unobserve(entry.target);
  });
}, { threshold: 0.14 });

document.querySelectorAll(".reveal").forEach((element) => observer.observe(element));

const tilt = document.querySelector("[data-tilt]");
if (tilt && matchMedia("(pointer: fine)").matches && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
  const stage = tilt.parentElement;
  stage.addEventListener("pointermove", (event) => {
    const bounds = stage.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width - 0.5;
    const y = (event.clientY - bounds.top) / bounds.height - 0.5;
    tilt.style.transform = `rotateY(${(-7 + x * 5).toFixed(2)}deg) rotateX(${(2 - y * 4).toFixed(2)}deg) rotateZ(1.5deg) translate3d(${(x * 5).toFixed(1)}px, ${(y * 5).toFixed(1)}px, 0)`;
  });
  stage.addEventListener("pointerleave", () => {
    tilt.style.transform = "rotateY(-7deg) rotateX(2deg) rotateZ(1.5deg)";
  });
}

const releasePage = "https://github.com/shiv213/redliner/releases/latest";
fetch("https://api.github.com/repos/shiv213/redliner/releases/latest", {
  headers: { Accept: "application/vnd.github+json" },
})
  .then((response) => response.ok ? response.json() : Promise.reject(new Error("release unavailable")))
  .then((release) => {
    const installer = release.assets?.find((asset) => asset.name.endsWith(".dmg"));
    document.querySelectorAll(".download-link").forEach((link) => {
      link.href = installer?.browser_download_url || release.html_url || releasePage;
    });
  })
  .catch(() => {
    document.querySelectorAll(".download-link").forEach((link) => { link.href = releasePage; });
  });
