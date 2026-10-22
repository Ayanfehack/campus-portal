const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());
app.use(cors());

if (!fs.existsSync('./uploads')) {
    fs.mkdirSync('./uploads');
}

// Configure Multer Upload Storage
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage: storage });
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// PostgreSQL Connection Configuration
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:cluster4@localhost:5432/campus_portal',
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'your-email@gmail.com', // Replace with your test email
        pass: 'your-email-app-password' // Replace with your email app password
    }
});

// Helper function to send emails
async function sendNotificationEmail(toEmail, subject, message) {
    try {
        await transporter.sendMail({
            from: '"UniClarity Support" <support@campus.edu.ng>',
            to: toEmail,
            subject: subject,
            text: message
        });
        console.log(`Email sent successfully to ${toEmail}`);
    } catch (err) {
        console.error('Email sending failed (Check credentials):', err.message);
    }
}

// Initialize Database Tables & Ensure All Required Columns Exist
async function initDb() {
    try {
        // Users Table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                full_name VARCHAR(255) NOT NULL,
                user_id VARCHAR(100) UNIQUE NOT NULL,
                email VARCHAR(255) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                role VARCHAR(50) NOT NULL,
                faculty VARCHAR(255),
                department VARCHAR(255),
                level VARCHAR(50),
                staff_role VARCHAR(100)
            );
        `);

        // Complaints Table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS complaints (
                id VARCHAR(50) PRIMARY KEY,
                student_id VARCHAR(100),
                student_name VARCHAR(255),
                student_department VARCHAR(255),
                category VARCHAR(100),
                type VARCHAR(100),
                description TEXT,
                status VARCHAR(50),
                assigned_to VARCHAR(255),
                feedback TEXT,
                attachment VARCHAR(255),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Safely add missing complaint response columns
        await pool.query(`ALTER TABLE complaints ADD COLUMN IF NOT EXISTS reply TEXT;`);
        await pool.query(`ALTER TABLE complaints ADD COLUMN IF NOT EXISTS replied_by VARCHAR(255);`);
        await pool.query(`ALTER TABLE complaints ADD COLUMN IF NOT EXISTS replied_at TIMESTAMP;`);
        await pool.query(`ALTER TABLE complaints ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;`);

        // Appointments Table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS appointments (
                id VARCHAR(50) PRIMARY KEY,
                student_id VARCHAR(100),
                student_name VARCHAR(255),
                staff_department VARCHAR(100),
                preferred_date VARCHAR(100),
                reason TEXT,
                status VARCHAR(50),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Safely add missing appointment reschedule columns
        await pool.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS date VARCHAR(100);`);
        await pool.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS time VARCHAR(100);`);
        await pool.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS staff_note TEXT;`);
        await pool.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;`);

        console.log('PostgreSQL database tables verified/created successfully.');
    } catch (err) {
        console.error('Error creating database tables:', err);
    }
}

initDb();

// ------------------- API ENDPOINTS -------------------

// 1. REGISTER USER
app.post('/api/register', async (req, res) => {
    const { fullName, userId, email, password, role, faculty, department, level, staffRole } = req.body;
    try {
        const userExists = await pool.query(
            'SELECT * FROM users WHERE user_id = $1 OR email = $2',
            [userId, email]
        );
        if (userExists.rows.length > 0) {
            return res.status(400).json({ error: 'ID or Email already registered.' });
        }

        await pool.query(
            `INSERT INTO users (full_name, user_id, email, password, role, faculty, department, level, staff_role)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [fullName, userId, email, password, role || 'student', faculty, department, level, staffRole]
        );

        res.status(201).json({ success: true, message: 'Registration successful!' });
    } catch (err) {
        console.error('Register Error:', err);
        res.status(500).json({ error: 'Database error during registration.' });
    }
});

// 2. LOGIN USER
app.post('/api/login', async (req, res) => {
    const { userId, password } = req.body;
    try {
        const userResult = await pool.query(
            'SELECT * FROM users WHERE user_id = $1 AND password = $2',
            [userId, password]
        );

        if (userResult.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid ID or Password.' });
        }

        const u = userResult.rows[0];
        res.json({
            success: true,
            user: {
                fullName: u.full_name,
                userId: u.user_id,
                email: u.email,
                role: u.role,
                faculty: u.faculty,
                department: u.department,
                level: u.level,
                staffRole: u.staff_role
            }
        });
    } catch (err) {
        console.error('Login Error:', err);
        res.status(500).json({ error: 'Database error during login.' });
    }
});

// 3. RESET PASSWORD
app.post('/api/reset-password', async (req, res) => {
    const { userId, newPassword } = req.body;
    try {
        const check = await pool.query('SELECT * FROM users WHERE user_id = $1 OR email = $1', [userId]);
        if (check.rows.length === 0) {
            return res.status(404).json({ error: 'User record not found.' });
        }

        await pool.query('UPDATE users SET password = $1 WHERE user_id = $2 OR email = $2', [newPassword, userId]);
        res.json({ success: true, message: 'Password reset successfully!' });
    } catch (err) {
        console.error('Reset Password Error:', err);
        res.status(500).json({ error: 'Database error during password reset.' });
    }
});

// 4. SUBMIT COMPLAINT
app.post('/api/complaints', upload.single('attachment'), async (req, res) => {
    const { studentId, studentName, studentDepartment, category, description } = req.body;
    const ticketId = 'CMP-' + Math.floor(100000 + Math.random() * 900000);
    const attachmentFile = req.file ? req.file.filename : null;

    let assignedTo = 'Head Administrative Staff';
    if (category === 'Academic') {
        assignedTo = `Part Adviser (${studentDepartment || 'General'})`;
    } else if (category === 'Hostel') {
        assignedTo = 'Dean of Student Affairs';
    } else if (category === 'Finance') {
        assignedTo = 'Cash Officers';
    }

    try {
        await pool.query(
            `INSERT INTO complaints (id, student_id, student_name, student_department, category, type, description, status, assigned_to, feedback, attachment)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [ticketId, studentId, studentName, studentDepartment, category, 'Escalated Ticket', description, 'In Progress', assignedTo, 'Forwarded to designated officer.', attachmentFile]
        );

        res.status(201).json({ success: true, ticketId, assignedTo });
    } catch (err) {
        console.error('Complaint Error:', err);
        res.status(500).json({ error: 'Failed to record complaint.' });
    }
});

// GET COMPLAINTS (Supports both Students & Staff)
app.get('/api/complaints', async (req, res) => {
    const { userId, role, department } = req.query;

    try {
        let queryText = '';
        let queryParams = [];

        if (role === 'staff' || role === 'admin') {
            if (department && department !== 'All') {
                queryText = 'SELECT * FROM complaints WHERE student_department ILIKE $1 OR category ILIKE $1 OR assigned_to ILIKE $1 ORDER BY created_at DESC';
                queryParams = [`%${department}%`];
            } else {
                queryText = 'SELECT * FROM complaints ORDER BY created_at DESC';
                queryParams = [];
            }
        } else {
            queryText = 'SELECT * FROM complaints WHERE student_id = $1 ORDER BY created_at DESC';
            queryParams = [userId];
        }

        // ─── CHANGE 'db.query' TO 'pool.query' HERE ───
        const result = await pool.query(queryText, queryParams);
        
        res.json({ success: true, complaints: result.rows });
    } catch (err) {
        console.error("Error fetching complaints:", err);
        res.status(500).json({ error: "Failed to load complaints" });
    }
});

// 5. BOOK APPOINTMENT
app.post('/api/appointments', async (req, res) => {
    const { studentId, studentName, staffDepartment, preferredDate, reason } = req.body;
    const apptId = 'APT-' + Math.floor(100000 + Math.random() * 900000);

    try {
        await pool.query(
            `INSERT INTO appointments (id, student_id, student_name, staff_department, preferred_date, reason, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [apptId, studentId, studentName, staffDepartment, preferredDate, reason, 'Pending Approval']
        );

        res.status(201).json({ success: true, appointmentId: apptId });
    } catch (err) {
        console.error('Appointment Error:', err);
        res.status(500).json({ error: 'Failed to book appointment.' });
    }
});

// GET APPOINTMENTS
app.get('/api/appointments', async (req, res) => {
    const { userId, role, department } = req.query;

    try {
        let queryText = '';
        let queryParams = [];

        if (role === 'staff' || role === 'admin') {
            if (department && department !== 'All') {
                queryText = 'SELECT * FROM appointments WHERE staff_department ILIKE $1 ORDER BY created_at DESC';
                queryParams = [`%${department}%`];
            } else {
                queryText = 'SELECT * FROM appointments ORDER BY created_at DESC';
                queryParams = [];
            }
        } else {
            queryText = 'SELECT * FROM appointments WHERE student_id = $1 ORDER BY created_at DESC';
            queryParams = [userId];
        }

        const result = await pool.query(queryText, queryParams);
        res.json({ success: true, appointments: result.rows });
    } catch (err) {
        console.error("Error fetching appointments:", err);
        res.status(500).json({ error: "Failed to load appointments" });
    }
});

// 6. GET STUDENT RECORDS
app.get('/api/user-data/:studentId', async (req, res) => {
    const studentId = decodeURIComponent(req.params.studentId);
    try {
        const complaints = await pool.query('SELECT * FROM complaints WHERE student_id = $1 ORDER BY created_at DESC', [studentId]);
        const appointments = await pool.query('SELECT * FROM appointments WHERE student_id = $1 ORDER BY created_at DESC', [studentId]);

        res.json({ complaints: complaints.rows, appointments: appointments.rows });
    } catch (err) {
        console.error('User Data Error:', err);
        res.status(500).json({ error: 'Failed to retrieve user data.' });
    }
});

// 7. GET ADMIN / STAFF RECORDS
app.get('/api/admin-data', async (req, res) => {
    const { staffRole, department } = req.query;
    try {
        let complaintsQuery = 'SELECT * FROM complaints ORDER BY created_at DESC';
        let complaintsParams = [];

        if (staffRole === 'Part Adviser') {
            complaintsQuery = 'SELECT * FROM complaints WHERE category = $1 AND student_department = $2 ORDER BY created_at DESC';
            complaintsParams = ['Academic', department];
        } else if (staffRole === 'Dean of Student Affairs') {
            complaintsQuery = 'SELECT * FROM complaints WHERE category = $1 OR assigned_to ILIKE $2 ORDER BY created_at DESC';
            complaintsParams = ['Hostel', '%Dean of Student Affairs%'];
        } else if (staffRole === 'Cash Officer') {
            complaintsQuery = 'SELECT * FROM complaints WHERE category = $1 ORDER BY created_at DESC';
            complaintsParams = ['Finance'];
        } else if (staffRole === 'Head Administrative Staff') {
            complaintsQuery = 'SELECT * FROM complaints WHERE category = $1 ORDER BY created_at DESC';
            complaintsParams = ['General'];
        }

        const complaints = await pool.query(complaintsQuery, complaintsParams);
        const appointments = await pool.query(
            'SELECT * FROM appointments WHERE staff_department ILIKE $1 OR staff_department ILIKE $2 ORDER BY created_at DESC',
            [`%${staffRole}%`, `%${department}%`]
        );

        res.json({ complaints: complaints.rows, appointments: appointments.rows });
    } catch (err) {
        console.error('Admin Data Error:', err);
        res.status(500).json({ error: 'Failed to retrieve administrative records.' });
    }
});

// 8. STAFF REPLY TO COMPLAINT
app.post('/api/admin/reply-complaint', async (req, res) => {
    const { complaintId, replyText, status, repliedBy } = req.body;

    try {
        const query = `
            UPDATE complaints 
            SET reply = $1, 
                status = $2, 
                replied_by = $3, 
                replied_at = NOW(), 
                updated_at = NOW() 
            WHERE id = $4 
            RETURNING *;
        `;
        const params = [replyText, status || 'Resolved', repliedBy, complaintId];
        
        const result = await pool.query(query, params);

        if (result.rowCount === 0) {
            return res.status(404).json({ error: "Complaint not found." });
        }

        res.json({ success: true, complaint: result.rows[0] });
    } catch (err) {
        console.error("Error replying to complaint:", err);
        res.status(500).json({ error: "Failed to send reply." });
    }
});

// 9. STAFF ACCEPT / RESCHEDULE APPOINTMENT
app.post('/api/admin/update-appointment', async (req, res) => {
    const { appointmentId, status, newDate, newTime, staffNote } = req.body;

    try {
        let query = '';
        let params = [];

        if (status === 'Rescheduled') {
            query = `
                UPDATE appointments 
                SET status = $1, date = $2, time = $3, staff_note = $4, updated_at = NOW() 
                WHERE id = $5 RETURNING *;
            `;
            params = [status, newDate, newTime, staffNote || 'Rescheduled by staff', appointmentId];
        } else {
            query = `
                UPDATE appointments 
                SET status = $1, staff_note = $2, updated_at = NOW() 
                WHERE id = $3 RETURNING *;
            `;
            params = [status, staffNote || `Appointment ${status.toLowerCase()}`, appointmentId];
        }

        const result = await pool.query(query, params);
        
        if (result.rowCount === 0) {
            return res.status(404).json({ error: "Appointment not found." });
        }

        res.json({ success: true, appointment: result.rows[0] });
    } catch (err) {
        console.error("Error updating appointment:", err);
        res.status(500).json({ error: "Failed to update appointment." });
    }
});

// 10. AI ASSISTANT CHAT ROUTE (Google Gemini)
const { GoogleGenAI } = require('@google/genai');
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

app.post('/api/chat', async (req, res) => {
    const { message, userName } = req.body;

    if (!message) {
        return res.status(400).json({ error: "Message is required." });
    }

    try {
        const systemInstruction = `
            You are UniClarity AI, an official university administrative assistant.
            
            Strict Administrative Routing Rules:
            1. If the user mentions "result", "grade", or "transcript", tell them to contact their Part Adviser or book an appointment via the portal.
            2. If the user mentions "hostel" or "accommodation", direct them to the Dean of Student Affairs (DSA).
            3. If the user complains about "portal access" or "login issues", tell them to click "Forgot Password" on the sign-in page and check their student email for the reset link.
            
            Tone & Style:
            - Concise, helpful, official, and warm.
            - User's Name: ${userName || 'Student'}.
            - Answer general university administrative questions accurately.
        `;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: message,
            config: {
                systemInstruction: systemInstruction,
                temperature: 0.3
            }
        });

        res.json({ 
            success: true, 
            reply: response.text 
        });

    } catch (err) {
        console.error("Gemini API Error:", err);
        res.status(500).json({ error: "AI Assistant unavailable right now." });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`UniClarity server running on port ${PORT}`);
});