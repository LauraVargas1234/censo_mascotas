// ============================================================
// db.js — PouchDB + SW + Push Notifications (RF10, RNF04)
// ============================================================

const DB_MASCOTAS = new PouchDB('pwa_mascotas');
const DB_PERSONAS = new PouchDB('pwa_personas');
const DB_CENSOS   = new PouchDB('pwa_censos');

// ---- Helper genérico ----
async function dbObtenerTodos(db) {
    const result = await db.allDocs({ include_docs: true });
    return result.rows
        .map(r => r.doc)
        .filter(d => d.syncStatus !== 'pending_delete' && !d._id.startsWith('_design'));
}

// ============================================================
// SERVICE WORKER
// ============================================================
var swRegistration = null;

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js')
        .then(reg => {
            swRegistration = reg;
            console.log('[SW] Registrado:', reg.scope);
            // Verificar si ya hay suscripción activa y actualizar botones
            reg.pushManager.getSubscription().then(sub => {
                actualizarBotonesPush(!!sub);
            });
        })
        .catch(err => console.warn('[SW] Error al registrar:', err));
}

// ============================================================
// PUSH NOTIFICATIONS (RF10, RNF04)
// ============================================================

function actualizarBotonesPush(suscrito) {
    const btnOn  = document.getElementById('btnActivada');
    const btnOff = document.getElementById('btnDesactivada');
    if (!btnOn || !btnOff) return;
    if (suscrito) {
        btnOn.classList.remove('d-none');
        btnOff.classList.add('d-none');
    } else {
        btnOn.classList.add('d-none');
        btnOff.classList.remove('d-none');
    }
}

function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const output  = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) output[i] = rawData.charCodeAt(i);
    return output;
}

async function suscribirPush() {
    // 1. Verificar soporte
    if (!('Notification' in window) || !('PushManager' in window)) {
        alert('Tu navegador no soporta notificaciones push.');
        return;
    }

    // 2. Pedir permiso
    const permiso = await Notification.requestPermission();
    if (permiso !== 'granted') {
        alert('Permiso de notificaciones denegado. Actívalo en la configuración del navegador.');
        return;
    }

    // 3. Esperar a que el SW esté listo (resuelve el race condition)
    let reg = swRegistration;
    if (!reg) {
        try {
            reg = await navigator.serviceWorker.ready;
            swRegistration = reg;
        } catch(e) {
            alert('El Service Worker no está disponible. Recarga la página.');
            return;
        }
    }

    const btnOff = document.getElementById('btnDesactivada');
    if (btnOff) { btnOff.disabled = true; btnOff.textContent = '⏳ Activando...'; }

    try {
        // 4. Obtener clave VAPID pública del servidor
        const resKey = await fetch(`${API_URL}/api/v1/push/key`);
        if (!resKey.ok) throw new Error(`El servidor no entregó la clave VAPID (HTTP ${resKey.status})`);
        const keyData = await resKey.json();
        const vapidKey = keyData.publicKey || await resKey.text();

        // 5. Suscribir al Push Manager del navegador
        const subscription = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(vapidKey.trim())
        });

        // 6. Enviar suscripción al servidor para que pueda enviar notificaciones
        const resSub = await fetch(`${API_URL}/api/v1/push/subscriptions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + token
            },
            body: JSON.stringify(subscription.toJSON())
        });
        if (!resSub.ok) throw new Error(`Error al registrar suscripción (HTTP ${resSub.status})`);

        actualizarBotonesPush(true);
        console.log('[Push] Suscripción activa:', subscription.endpoint);

    } catch(err) {
        console.error('[Push] Error:', err);
        alert('No se pudo activar las notificaciones:\n' + err.message);
        actualizarBotonesPush(false);
    } finally {
        if (btnOff) { btnOff.disabled = false; btnOff.textContent = '🔕 Activar notif.'; }
    }
}

async function cancelarSuscripcion() {
    if (!swRegistration) return;
    try {
        const sub = await swRegistration.pushManager.getSubscription();
        if (sub) {
            await sub.unsubscribe();
            console.log('[Push] Suscripción cancelada');
        }
        actualizarBotonesPush(false);
    } catch(err) {
        console.error('[Push] Error al cancelar:', err);
    }
}

// ============================================================
// BADGE ESTADO CONEXIÓN
// ============================================================
function actualizarBadgeEstado() {
    const badge = document.getElementById('syncStatus');
    if (!badge) return;
    if (navigator.onLine) {
        badge.textContent = 'En línea';
        badge.className = 'badge bg-success ms-2';
    } else {
        badge.textContent = 'Sin conexión';
        badge.className = 'badge bg-warning text-dark ms-2';
    }
}
window.addEventListener('online',  actualizarBadgeEstado);
window.addEventListener('offline', actualizarBadgeEstado);
document.addEventListener('DOMContentLoaded', actualizarBadgeEstado);
