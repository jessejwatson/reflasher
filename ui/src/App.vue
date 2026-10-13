<script setup>
import { computed, onMounted, ref } from 'vue';
import * as api from './api.js';

const images = ref([]);
const scripts = ref([]);
const scriptBase = ref(null); // e.g. http://10.0.0.5:8080 — null when unknown
const authRequired = ref(false);
const needsLogin = ref(false);
const ready = ref(false); // first state load done — avoids flashing the UI before login
const password = ref('');
const error = ref('');
const busy = ref(false);

const upload = ref(null); // { name, progress }
const fileInput = ref(null);

const newScript = ref({ name: '', image: '' });
const copied = ref('');

const activeImages = computed(() => images.value.filter((i) => !i.archived));
const archivedImages = computed(() => images.value.filter((i) => i.archived));
const usedBy = (name) => scripts.value.filter((s) => s.image === name).map((s) => s.name);

async function refresh() {
  try {
    const state = await api.getState();
    images.value = state.images;
    scripts.value = state.scripts;
    scriptBase.value = state.scriptBase;
    authRequired.value = state.authRequired;
    needsLogin.value = false;
  } catch (e) {
    if (e.status === 401) needsLogin.value = true;
    else error.value = e.message;
  } finally {
    ready.value = true;
  }
}

// Runs an action, surfaces any error, then reloads state from the server.
async function run(fn) {
  error.value = '';
  busy.value = true;
  try {
    await fn();
  } catch (e) {
    if (e.status !== 401) error.value = e.message;
  } finally {
    busy.value = false;
    await refresh();
  }
}

async function submitLogin() {
  error.value = '';
  busy.value = true;
  try {
    await api.login(password.value);
    password.value = '';
    await refresh();
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}

function logout() {
  run(() => api.logout());
}

function onFileChosen(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (!/\.img\.xz$/.test(file.name)) {
    error.value = 'Only .img.xz images can be uploaded.';
    return;
  }
  if (images.value.some((i) => i.name === file.name)) {
    error.value = `${file.name} already exists — delete it or rename the file first.`;
    return;
  }
  upload.value = { name: file.name, progress: 0 };
  run(() => api.uploadImage(file, (p) => { upload.value.progress = p; }))
    .finally(() => { upload.value = null; });
}

function remove(img) {
  if (!confirm(`Permanently delete ${img.name}?`)) return;
  run(() => api.deleteImage(img.name));
}

function addScript() {
  const { name, image } = newScript.value;
  if (scripts.value.some((s) => s.name === name)) {
    error.value = `A script named "${name}" already exists.`;
    return;
  }
  run(async () => {
    await api.saveScript(name, image);
    newScript.value = { name: '', image: '' };
  });
}

function removeScript(s) {
  if (!confirm(`Remove script "${s.name}"? Pis using its URL will stop working.`)) return;
  run(() => api.deleteScript(s.name));
}

const curlFor = (name) =>
  `curl -fsSL ${scriptBase.value || 'http://SERVER_IP:8080'}/reflash/${name}.sh | sudo bash`;

async function copy(name) {
  await navigator.clipboard.writeText(curlFor(name));
  copied.value = name;
  setTimeout(() => { if (copied.value === name) copied.value = ''; }, 1500);
}

function size(b) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(1)} ${u[i]}`;
}
const date = (iso) => new Date(iso).toLocaleString();

onMounted(refresh);
</script>

<template>
  <div v-if="needsLogin" class="login-page">
    <form class="card login" @submit.prevent="submitLogin">
      <h1>Reflasher</h1>
      <p class="muted">Enter the admin password to manage images.</p>
      <p v-if="error" class="alert error">{{ error }}</p>
      <input v-model="password" type="password" placeholder="Password" autocomplete="current-password" autofocus required />
      <button class="primary" type="submit" :disabled="busy">Log in</button>
    </form>
  </div>

  <main v-else-if="ready">
    <header class="topbar">
      <div>
        <h1>Reflasher</h1>
        <p class="muted">Raspberry Pi images and the scripts that flash them.</p>
      </div>
      <button v-if="authRequired" :disabled="busy" @click="logout">Log out</button>
    </header>

    <p v-if="error" class="alert error" @click="error = ''">{{ error }}</p>

    <section class="card">
      <div class="card-head">
        <div>
          <h2>Scripts</h2>
          <p class="muted">Run on a Pi as root to flash its assigned image. Pis must use the server's IP address.</p>
        </div>
      </div>

      <p v-if="!scriptBase" class="alert warn">
        This page is behind a proxy, so the server can't tell which address Pis should use.
        Set <code>REFLASHER_PUBLIC_URL</code> (e.g. <code>http://10.0.0.5:8080</code>) on the server,
        or replace <code>SERVER_IP</code> below yourself.
      </p>

      <ul v-if="scripts.length" class="scripts">
        <li v-for="s in scripts" :key="s.name">
          <div class="script-row">
            <span class="script-name">{{ s.name }}</span>
            <select :value="s.image" :disabled="busy" @change="run(() => api.saveScript(s.name, $event.target.value))">
              <option v-if="!activeImages.some((i) => i.name === s.image)" :value="s.image" disabled>
                {{ s.image }} (missing)
              </option>
              <option v-for="i in activeImages" :key="i.name" :value="i.name">{{ i.name }}</option>
            </select>
            <button class="ghost danger" :disabled="busy" @click="removeScript(s)">Remove</button>
          </div>
          <div class="command">
            <code>{{ curlFor(s.name) }}</code>
            <button class="ghost" @click="copy(s.name)">{{ copied === s.name ? 'Copied ✓' : 'Copy' }}</button>
          </div>
        </li>
      </ul>
      <p v-else class="empty">No scripts yet — add one below.</p>

      <form class="add" @submit.prevent="addScript">
        <input
          v-model.trim="newScript.name"
          placeholder="Script name, e.g. pi4"
          pattern="[a-z0-9][a-z0-9_\-]*"
          title="Lowercase letters, digits, - and _"
          required
        />
        <select v-model="newScript.image" required>
          <option value="" disabled>Choose image…</option>
          <option v-for="i in activeImages" :key="i.name" :value="i.name">{{ i.name }}</option>
        </select>
        <button class="primary" type="submit" :disabled="busy || !activeImages.length">Add script</button>
      </form>
    </section>

    <section class="card">
      <div class="card-head">
        <div>
          <h2>Images</h2>
          <p class="muted">Compressed <code>.img.xz</code> images. Unassign an image from all scripts before archiving or deleting it.</p>
        </div>
        <input ref="fileInput" type="file" accept=".xz" hidden @change="onFileChosen" />
        <button class="primary" :disabled="busy" @click="fileInput.click()">Upload image</button>
      </div>

      <div v-if="upload" class="progress">
        <div class="progress-label">
          <span>Uploading {{ upload.name }}</span>
          <span>{{ Math.round(upload.progress * 100) }}%</span>
        </div>
        <div class="bar"><div :style="{ width: upload.progress * 100 + '%' }"></div></div>
      </div>

      <table v-if="images.length">
        <thead>
          <tr><th>Name</th><th>Size</th><th>Modified</th><th>Used by</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="img in activeImages" :key="img.name">
            <td class="name">{{ img.name }}</td>
            <td class="meta">{{ size(img.size) }}</td>
            <td class="meta">{{ date(img.modified) }}</td>
            <td>
              <span v-for="n in usedBy(img.name)" :key="n" class="pill">{{ n }}</span>
              <span v-if="!usedBy(img.name).length" class="muted">—</span>
            </td>
            <td class="actions">
              <template v-if="!usedBy(img.name).length">
                <button class="ghost" :disabled="busy" @click="run(() => api.archiveImage(img.name))">Archive</button>
                <button class="ghost danger" :disabled="busy" @click="remove(img)">Delete</button>
              </template>
            </td>
          </tr>
          <tr v-if="archivedImages.length" class="group">
            <td colspan="5">Archived</td>
          </tr>
          <tr v-for="img in archivedImages" :key="img.name" class="archived">
            <td class="name">{{ img.name }}</td>
            <td class="meta">{{ size(img.size) }}</td>
            <td class="meta">{{ date(img.modified) }}</td>
            <td></td>
            <td class="actions">
              <button class="ghost" :disabled="busy" @click="run(() => api.unarchiveImage(img.name))">Restore</button>
              <button class="ghost danger" :disabled="busy" @click="remove(img)">Delete</button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty">No images yet. Upload one to get started.</p>
    </section>
  </main>
</template>
