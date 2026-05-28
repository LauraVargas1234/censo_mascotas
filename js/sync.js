// ============================================================
// sync.js — SyncManager
// ============================================================

 
 
const API_URL = 'https://elprofehugo.online';

// ============================================================
// Cloudinary — subir foto y obtener URL pública
// Reemplaza TU_CLOUD_NAME y TU_UPLOAD_PRESET con los tuyos
// ============================================================
const CLOUDINARY_CLOUD_NAME  = 'djqdqiix7';
const CLOUDINARY_UPLOAD_PRESET = 'mascotas_pwa';

async function subirFotoCloudinary(base64) {
    // Quitar prefijo data:image/jpeg;base64,
    const base64Limpio = base64.split(',')[1] || base64;
    const formData = new FormData();
    formData.append('file',           'data:image/jpeg;base64,' + base64Limpio);
    formData.append('upload_preset',  CLOUDINARY_UPLOAD_PRESET);
    formData.append('folder',         'mascotas_pwa');

    const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`, {
        method: 'POST',
        body: formData
    });
    if (!res.ok) {
        const err = await res.text();
        throw new Error('Cloudinary error: ' + err);
    }
    const data = await res.json();
    return data.secure_url; // URL pública https://res.cloudinary.com/...
}

function getHeaders(conAuth = true) {
    const h = { 'Content-Type': 'application/json' };
    if (conAuth) {
        const token = localStorage.getItem('token');
        if (token) h['Authorization'] = 'Bearer ' + token;
    }
    return h;
}

class SyncManager {
    constructor() {
        this.syncing = false;
        this._setupListeners();
        setInterval(() => this.sync(), 30000);
    }

    _setupListeners() {
        window.addEventListener('online',  () => { this._updateStatus(); this.sync(); });
        window.addEventListener('offline', () => this._updateStatus());
        this._updateStatus();
    }

    _updateStatus() {
        const badge = document.getElementById('syncStatus');
        if (!badge) return;
        badge.textContent = navigator.onLine ? 'En línea' : 'Sin conexión';
        badge.className   = 'badge ms-2 ' + (navigator.onLine ? 'bg-success' : 'bg-warning text-dark');
    }

    _setSyncingUI(syncing) {
        const btn = document.getElementById('btnSync');
        if (!btn) return;
        btn.disabled    = syncing;
        btn.textContent = syncing ? 'Sincronizando...' : 'Sincronizar';
    }

    async sync() {
        if (this.syncing || !navigator.onLine) return;
        this.syncing = true;
        this._setSyncingUI(true);
        try {
            await this.syncPersonas();
            await this.syncMascotas();
            await this.syncCensos();
            if (typeof cargarMascotas  === 'function') cargarMascotas();
            if (typeof cargarPersonas  === 'function') cargarPersonas();
            if (typeof cargarMisCensos === 'function') cargarMisCensos();
        } catch (err) {
            console.error('[Sync] Error general:', err);
        } finally {
            this.syncing = false;
            this._setSyncingUI(false);
        }
    }

    // ---- PERSONAS ----
    async syncPersonas() {
        const result  = await DB_PERSONAS.allDocs({ include_docs: true });
        const pending = result.rows.filter(r =>
            r.doc.syncStatus === 'pending_create' && !r.doc._id.startsWith('_design')
        );
        for (const row of pending) {
            const doc = row.doc;
            try {
                // La spec dice que personas SÍ envía id generado desde el front
                const payload = {
                    nombres:       doc.nombres,
                    apellidos:     doc.apellidos,
                    tipoDocumento: doc.tipoDocumento,
                    documento:     doc.documento,
                    direccion:     doc.direccion,
                    telefono:      doc.telefono,
                    ciudad:        doc.ciudad,
                    usuario:       doc.usuario,
                    contrasena:    doc.contrasenaHash || ''
                };
                const res = await fetch(`${API_URL}/api/v1/personas`, {
                    method: 'POST', headers: getHeaders(false),
                    body: JSON.stringify(payload)
                });
                if (!res.ok) {
                    const det = await res.text().catch(() => '');
                    throw new Error(`HTTP ${res.status}: ${det}`);
                }
                const created = await res.json();
                const docLimpio = { ...doc };
                delete docLimpio.contrasenaHash;
                await DB_PERSONAS.put({ ...docLimpio, remoteId: created.id, syncStatus: 'synced' });
                console.log('[Sync Personas] ✓', created.id);
            } catch (err) {
                console.error('[Sync Personas]', doc._id, err.message);
            }
        }

        // Sync-down
        try {
            const res = await fetch(`${API_URL}/api/v1/personas`, { headers: getHeaders(false) });
            if (!res.ok) return;
            const remotas = await res.json();
            const local   = await DB_PERSONAS.allDocs({ include_docs: true });
            const map     = {};
            local.rows.forEach(r => { if (r.doc.remoteId) map[r.doc.remoteId] = true; });
            for (const r of remotas) {
                if (!map[r.id]) {
                    await DB_PERSONAS.put({
                        _id: 'remote-' + r.id,
                        nombres: r.nombres, apellidos: r.apellidos,
                        tipoDocumento: r.tipoDocumento, documento: r.documento,
                        direccion: r.direccion, telefono: r.telefono,
                        ciudad: r.ciudad, usuario: r.usuario,
                        remoteId: r.id, syncStatus: 'synced'
                    });
                }
            }
        } catch (err) { console.warn('[Sync Personas down]', err.message); }
    }

    // ---- MASCOTAS ----
    async syncMascotas() {
        const result  = await DB_MASCOTAS.allDocs({ include_docs: true });
        const pending = result.rows.filter(r =>
            r.doc.syncStatus && r.doc.syncStatus !== 'synced' && !r.doc._id.startsWith('_design')
        );
        for (const row of pending) {
            const doc = row.doc;
            try {
                if (doc.syncStatus === 'pending_create') {

                    // Subir foto a Cloudinary si es Base64
                    let fotoUrl = doc.fotografia || '';
                    if (fotoUrl.startsWith('data:')) {
                        fotoUrl = await subirFotoCloudinary(fotoUrl);
                    } else if (!fotoUrl.startsWith('http')) {
                        fotoUrl = `https://placehold.co/150x150/C5C2FF/7A75C9?text=${encodeURIComponent(doc.nombre)}`;
                    }

                    // La spec dice que mascotas SÍ envía id generado desde el front
                    const payload = {
                        nombre:     doc.nombre,
                        tipo:       doc.tipo,
                        genero:     doc.genero || '',
                        edad:       doc.edad,
                        fotografia: fotoUrl
                    };
                    const res = await fetch(`${API_URL}/api/v1/mascotas`, {
                        method: 'POST', headers: getHeaders(true),
                        body: JSON.stringify(payload)
                    });
                    if (!res.ok) {
                        const det = await res.text().catch(() => '');
                        throw new Error(`HTTP ${res.status}: ${det}`);
                    }
                    const created = await res.json();
                    await DB_MASCOTAS.put({ ...doc, fotografia: fotoUrl, remoteId: created.id, syncStatus: 'synced' });
                    console.log('[Sync Mascotas] ✓', created.id);

                } else if (doc.syncStatus === 'pending_update' && doc.remoteId) {
                    const res = await fetch(`${API_URL}/api/v1/mascotas/${doc.remoteId}`, {
                        method: 'PATCH', headers: getHeaders(true),
                        body: JSON.stringify({ nombre: doc.nombre, tipo: doc.tipo, genero: doc.genero, edad: doc.edad })
                    });
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    await DB_MASCOTAS.put({ ...doc, syncStatus: 'synced' });

                } else if (doc.syncStatus === 'pending_delete') {
                    if (doc.remoteId) {
                        const res = await fetch(`${API_URL}/api/v1/mascotas/${doc.remoteId}`, {
                            method: 'DELETE', headers: getHeaders(true)
                        });
                        if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
                    }
                    await DB_MASCOTAS.remove(doc);
                }
            } catch (err) {
                console.error('[Sync Mascotas]', doc._id, err.message);
            }
        }

        // Sync-down
        try {
            const res = await fetch(`${API_URL}/api/v1/mascotas`, { headers: getHeaders(false) });
            if (!res.ok) return;
            const remotas = await res.json();
            const local   = await DB_MASCOTAS.allDocs({ include_docs: true });
            const map     = {};
            local.rows.forEach(r => { if (r.doc.remoteId) map[r.doc.remoteId] = true; });
            for (const r of remotas) {
                if (!map[r.id]) {
                    await DB_MASCOTAS.put({
                        _id: 'remote-' + r.id,
                        nombre: r.nombre, tipo: r.tipo, genero: r.genero || '',
                        edad: r.edad, fotografia: r.fotografia || '',
                        remoteId: r.id, syncStatus: 'synced'
                    });
                }
            }
        } catch (err) { console.warn('[Sync Mascotas down]', err.message); }
    }

    // ---- CENSOS ----
    async syncCensos() {
        const result  = await DB_CENSOS.allDocs({ include_docs: true });
        const pending = result.rows.filter(r =>
            r.doc.syncStatus === 'pending_create' && !r.doc._id.startsWith('_design')
        );
        for (const row of pending) {
            const doc = row.doc;
            try {
                // Resolver remoteId de mascota
                let idMascota = doc.idMascota;  // ← declarar aquí
        let idDueno   = doc.idDueno;   // ← declarar aquí
idMascota = doc.idMascota;
const allM = await DB_MASCOTAS.allDocs({ include_docs: true });
const foundM = allM.rows.find(r =>
    r.doc._id === doc.idMascota ||
    r.doc.remoteId === doc.idMascota
);
if (foundM && foundM.doc.remoteId) {
    idMascota = foundM.doc.remoteId;
} else if (!idMascota || idMascota.length !== 36) {
    console.warn('[Sync Censos] Sin remoteId de mascota, esperando...');
    continue;
}

// Resolver remoteId de persona
idDueno = doc.idDueno;
const allP = await DB_PERSONAS.allDocs({ include_docs: true });
const foundP = allP.rows.find(r =>
    r.doc._id === doc.idDueno ||
    r.doc.remoteId === doc.idDueno
);
if (foundP && foundP.doc.remoteId) {
    idDueno = foundP.doc.remoteId;
} else if (!idDueno || idDueno.length !== 36) {
    console.warn('[Sync Censos] Sin remoteId de persona, esperando...');
    continue;
}
                // Si la mascota aún no se sincronizó, esperar
                if (!foundM || !foundM.doc.remoteId) {
                    console.warn('[Sync Censos] Mascota aún pendiente, esperando...');
                    continue;
                }

                // Censos NO envía id — lo genera el backend
                const payload = {
                    idMascota: idMascota,
                    idDueno:    idDueno,
                    fotografia: doc.fotografia,
                    lat:        doc.lat,
                    lon:        doc.lon,
                    idProyecto: doc.idProyecto,
                    color:      doc.color
                };
                const res = await fetch(`${API_URL}/api/v1/censos`, {
                    method: 'POST', headers: getHeaders(true),
                    body: JSON.stringify(payload)
                });
                if (!res.ok) {
                    const det = await res.text().catch(() => '');
                    throw new Error(`HTTP ${res.status}: ${det}`);
                }
                const created = await res.json();
                await DB_CENSOS.put({
                    ...doc,
                    idMascota: idMascota,
                    idDueno: idDueno,
                    remoteId: created.id,
                    syncStatus: 'synced'
                });
                console.log('[Sync Censos] ✓', created.id);
            } catch (err) {
                console.error('[Sync Censos]', doc._id, err.message);
            }
        }

        // Sync-down censos
        try {
            const res = await fetch(`${API_URL}/api/v1/censos`, {
                headers: getHeaders(true)
            });

            if (!res.ok) return;

            const remotos = await res.json();

            const local = await DB_CENSOS.allDocs({ include_docs: true });

            const map = {};

            local.rows.forEach(r => {
                if (r.doc.remoteId) {
                    map[r.doc.remoteId] = true;
                }
            });

            for (const r of remotos) {

            // Solo traer censos del proyecto PWA_GRUPO_08
            if (r.idProyecto !== 'PWA_GRUPO_08') {
                continue;
            }

            if (!map[r.id]) {

                    await DB_CENSOS.put({
                        _id: 'remote-' + r.id,

                        remoteId: r.id,

                        idMascota: r.idMascota,
                        idDueno: r.idDueno,

                        mascota: r.mascota || null,
                        dueno: r.dueno || null,

                        fotografia: r.fotografia,
                        lat: r.lat,
                        lon: r.lon,

                        idProyecto: r.idProyecto,
                        color: r.color,

                        syncStatus: 'synced'
                    });

                    console.log('[Sync Censos DOWN] ✓', r.id);
                }
            }

        } catch(err) {
            console.warn('[Sync Censos down]', err.message);
        }
    }
}

const syncManager = new SyncManager();
function sincronizarTodo() { syncManager.sync(); }