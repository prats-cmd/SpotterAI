// ──────────────────────────────────────────────────────────────────────────────
// Spotter Memory Service — JSON-backed persistent user storage
// ──────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_FILE = path.join(__dirname, '..', 'data', 'users.json');

// Simple write lock to prevent concurrent corruption
let writeLock = false;
const writeQueue = [];

function processWriteQueue() {
    if (writeLock || writeQueue.length === 0) return;
    writeLock = true;
    const { data, resolve, reject } = writeQueue.shift();
    fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2), 'utf8', (err) => {
        writeLock = false;
        if (err) reject(err);
        else resolve();
        processWriteQueue(); // drain queue
    });
}

// ── Read all users ───────────────────────────────────────────────────────────
function readDB() {
    try {
        if (!fs.existsSync(DATA_FILE)) {
            fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
            fs.writeFileSync(DATA_FILE, JSON.stringify({ users: {} }, null, 2), 'utf8');
        }
        const raw = fs.readFileSync(DATA_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || !parsed.users) {
            return { users: {} };
        }
        return parsed;
    } catch (e) {
        console.error('[memory] Failed to read users.json:', e.message);
        return { users: {} };
    }
}

// ── Write all users (queued, non-blocking) ───────────────────────────────────
function writeDB(data) {
    return new Promise((resolve, reject) => {
        writeQueue.push({ data, resolve, reject });
        processWriteQueue();
    });
}

// ── Generate a new anonymous user ID ─────────────────────────────────────────
function generateUserId() {
    return 'spotter-' + crypto.randomUUID();
}

// ── Get or create a user record ──────────────────────────────────────────────
function getOrCreateUser(userId) {
    const db = readDB();

    if (db.users[userId]) {
        return { user: db.users[userId], isNew: false };
    }

    // Create a fresh anonymous profile
    const newUser = {
        profile: {
            goal: '',
            experience: '',
            equipment: []
        },
        workouts: [],
        personalRecords: [],
        streak: 0,
        preferences: {
            coachingStyle: 'Encouraging'
        },
        conversationSummaries: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    db.users[userId] = newUser;
    writeDB(db).catch(err => console.error('[memory] Failed to save new user:', err.message));

    return { user: newUser, isNew: true };
}

// ── Save a workout ───────────────────────────────────────────────────────────
async function saveWorkout(userId, workout) {
    const db = readDB();
    if (!db.users[userId]) {
        db.users[userId] = getOrCreateUser(userId).user;
    }

    const record = {
        date: workout.date || new Date().toISOString().split('T')[0],
        exercise: workout.exercise || 'Unknown exercise',
        sets: workout.sets || [],
        fatigue: workout.fatigue || '',
        notes: workout.notes || '',
        savedAt: new Date().toISOString()
    };

    db.users[userId].workouts.push(record);

    // Update streak logic
    const today = new Date().toISOString().split('T')[0];
    const workouts = db.users[userId].workouts;
    if (workouts.length >= 2) {
        const prevDate = workouts[workouts.length - 2].date;
        const prevDay = new Date(prevDate);
        const todayDay = new Date(today);
        const diffDays = Math.round((todayDay - prevDay) / (1000 * 60 * 60 * 24));
        if (diffDays <= 1) {
            db.users[userId].streak = (db.users[userId].streak || 0) + 1;
        } else if (diffDays > 2) {
            db.users[userId].streak = 1;
        }
    } else {
        db.users[userId].streak = 1;
    }

    // Update personal records
    if (record.sets && record.sets.length > 0) {
        const maxWeight = Math.max(...record.sets.map(s => s.weightKg || 0));
        if (maxWeight > 0) {
            const existing = db.users[userId].personalRecords.find(
                pr => pr.exercise.toLowerCase() === record.exercise.toLowerCase()
            );
            if (!existing || maxWeight > existing.weightKg) {
                if (existing) {
                    existing.weightKg = maxWeight;
                    existing.date = record.date;
                } else {
                    db.users[userId].personalRecords.push({
                        exercise: record.exercise,
                        weightKg: maxWeight,
                        date: record.date
                    });
                }
            }
        }
    }

    db.users[userId].updatedAt = new Date().toISOString();
    await writeDB(db);
    return record;
}

// ── Update user profile/preferences ──────────────────────────────────────────
async function updateProfile(userId, updates) {
    const db = readDB();
    if (!db.users[userId]) return null;

    if (updates.goal !== undefined) db.users[userId].profile.goal = updates.goal;
    if (updates.experience !== undefined) db.users[userId].profile.experience = updates.experience;
    if (updates.equipment !== undefined) db.users[userId].profile.equipment = updates.equipment;
    if (updates.coachingStyle !== undefined) db.users[userId].preferences.coachingStyle = updates.coachingStyle;

    db.users[userId].updatedAt = new Date().toISOString();
    await writeDB(db);
    return db.users[userId];
}

// ── Save a conversation summary ──────────────────────────────────────────────
async function saveConversationSummary(userId, summary) {
    const db = readDB();
    if (!db.users[userId]) return;

    // Keep last 10 conversation summaries to avoid bloat
    db.users[userId].conversationSummaries.push({
        summary: summary,
        date: new Date().toISOString()
    });
    if (db.users[userId].conversationSummaries.length > 10) {
        db.users[userId].conversationSummaries =
            db.users[userId].conversationSummaries.slice(-10);
    }

    db.users[userId].updatedAt = new Date().toISOString();
    await writeDB(db);
}

// ── Build AI context string from saved user data ─────────────────────────────
function buildContextForAI(userId) {
    const db = readDB();
    const user = db.users[userId];
    if (!user) return '';

    const parts = [];

    // Profile
    if (user.profile.goal || user.profile.experience) {
        parts.push(`USER PROFILE: Goal: ${user.profile.goal || 'Not set'}. Experience: ${user.profile.experience || 'Not set'}. Equipment: ${user.profile.equipment.length > 0 ? user.profile.equipment.join(', ') : 'Not specified'}.`);
    }

    // Preferences
    if (user.preferences.coachingStyle) {
        parts.push(`COACHING STYLE PREFERENCE: ${user.preferences.coachingStyle}.`);
    }

    // Streak
    if (user.streak > 0) {
        parts.push(`CURRENT STREAK: ${user.streak} day(s) in a row.`);
    }

    // Recent workouts (last 5)
    if (user.workouts.length > 0) {
        const recent = user.workouts.slice(-5);
        const workoutLines = recent.map(w => {
            const setStr = w.sets.map(s => `${s.reps} reps @ ${s.weightKg}kg`).join(', ');
            return `  - ${w.date}: ${w.exercise}${setStr ? ' (' + setStr + ')' : ''}${w.fatigue ? ' [Fatigue: ' + w.fatigue + ']' : ''}`;
        });
        parts.push(`RECENT WORKOUTS (last ${recent.length}):\n${workoutLines.join('\n')}`);
    }

    // Personal records
    if (user.personalRecords.length > 0) {
        const prLines = user.personalRecords.map(pr => `  - ${pr.exercise}: ${pr.weightKg}kg (${pr.date})`);
        parts.push(`PERSONAL RECORDS:\n${prLines.join('\n')}`);
    }

    // Recent conversation summaries (last 3)
    if (user.conversationSummaries && user.conversationSummaries.length > 0) {
        const recentSummaries = user.conversationSummaries.slice(-3);
        const summaryLines = recentSummaries.map(s => `  - ${s.date.split('T')[0]}: ${s.summary}`);
        parts.push(`PREVIOUS SESSION NOTES:\n${summaryLines.join('\n')}`);
    }

    if (parts.length === 0) return '';

    return '\n\n--- SAVED USER CONTEXT (from persistent memory) ---\n' +
           parts.join('\n') +
           '\n--- END OF SAVED CONTEXT ---\n' +
           'IMPORTANT: Only reference the workouts and data shown above. Never invent or fabricate workout records the user did not log.';
}

// ── Get memory status (for dashboard) ────────────────────────────────────────
function getMemoryStatus(userId) {
    const db = readDB();
    const user = db.users[userId];
    if (!user) {
        return {
            exists: false,
            userId: userId,
            workoutCount: 0,
            streak: 0,
            personalRecords: 0,
            lastUpdated: null,
            createdAt: null
        };
    }

    return {
        exists: true,
        userId: userId,
        workoutCount: user.workouts.length,
        streak: user.streak,
        personalRecords: user.personalRecords.length,
        lastUpdated: user.updatedAt,
        createdAt: user.createdAt,
        profile: user.profile,
        preferences: user.preferences
    };
}

// ── Clear a user's data ──────────────────────────────────────────────────────
async function clearUserData(userId) {
    const db = readDB();
    if (db.users[userId]) {
        delete db.users[userId];
        await writeDB(db);
        return true;
    }
    return false;
}

module.exports = {
    generateUserId,
    getOrCreateUser,
    saveWorkout,
    updateProfile,
    saveConversationSummary,
    buildContextForAI,
    getMemoryStatus,
    clearUserData
};
