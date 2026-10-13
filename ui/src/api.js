async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(res.status, data.error || `${res.status} ${res.statusText}`);
  return data;
}

// Errors carry the HTTP status so the app can show the login form on 401.
function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

const enc = encodeURIComponent;

export const login = (password) => request('POST', 'api/login', { password });
export const logout = () => request('POST', 'api/logout');

export const getState = () => request('GET', 'api/state');
export const archiveImage = (name) => request('POST', `api/images/${enc(name)}/archive`);
export const unarchiveImage = (name) => request('POST', `api/images/${enc(name)}/unarchive`);
export const deleteImage = (name) => request('DELETE', `api/images/${enc(name)}`);
export const saveScript = (name, image) => request('PUT', `api/scripts/${enc(name)}`, { image });
export const deleteScript = (name) => request('DELETE', `api/scripts/${enc(name)}`);

// XHR rather than fetch so we get upload progress for multi-GB images.
export function uploadImage(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `api/images/${enc(file.name)}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status < 300) return resolve();
      let msg = `${xhr.status} ${xhr.statusText}`;
      try { msg = JSON.parse(xhr.responseText).error || msg; } catch {}
      reject(httpError(xhr.status, msg));
    };
    xhr.onerror = () => reject(new Error('Upload failed (network error)'));
    xhr.send(file);
  });
}
