const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const multer = require('multer');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());

const fs = require('fs');
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

const nodemailer = require('nodemailer');

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
            from: '"Campus Portal" <support@campus.edu.ng>',
            to: toEmail,
            subject: subject,
            text: message
        });
        console.log(`Email sent successfully to ${toEmail}`);
    } catch (err) {
        console.error('Email sending failed (Check credentials):', err.message);
    }
}

// Initialize Database Tables
async function initDb() {
    try {
        // Users Table (Supports both Students & Staff with Roles)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                full_name VARCHAR(255) NOT NULL,
                user_id VARCHAR(100) UNIQUE NOT NULL,
                email VARCHAR(255) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                role VARCHAR(50) NOT NULL, -- 'student' or 'staff'
                faculty VARCHAR(255),
                department VARCHAR(255),
                level VARCHAR(50),
                staff_role VARCHAR(100) -- e.g., 'Part Adviser', 'Dean of Student Affairs', 'Cash Officer', 'Head Administrative Staff'
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
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Appointments Table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS appointments (
                id VARCHAR(50) PRIMARY KEY,
                student_id VARCHAR(100),
                student_name VARCHAR(255),
                staff_department VARCHAR(255),
                preferred_date VARCHAR(100),
                reason TEXT,
                status VARCHAR(50),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

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

// 4. SUBMIT COMPLAINT (WITH CATEGORY ROUTING & FILE UPLOAD)
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

// 5. BOOK APPOINTMENT
app.post('/api/appointments', async (req, res) => {
    const { studentId, studentName, staffDepartment, preferredDate, reason } = req.body;
    const apptId = 'APT-' + Math.floor(100000 + Math.random() * 900000);

    try {
        await pool.query(
            `INSERT INTO appointments (id, student_id, student_name, staff_department, preferred_date, reason, status)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [apptId, studentId, studentName, staffDepartment, preferredDate, reason, 'Pending Approval']
        );

        res.status(201).json({ success: true, appointmentId: apptId });
    } catch (err) {
        console.error('Appointment Error:', err);
        res.status(500).json({ error: 'Failed to book appointment.' });
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

// 8. UPDATE COMPLAINT STATUS
app.post('/api/admin/update-complaint', async (req, res) => {
    const { ticketId, status, feedback } = req.body;
    try {
        // 1. Update the database
        const updateResult = await pool.query(
            'UPDATE complaints SET status = $1, feedback = $2 WHERE id = $3 RETURNING *',
            [status, feedback, ticketId]
        );

        if (updateResult.rows.length > 0) {
            const complaint = updateResult.rows[0];
            
            // 2. Fetch the student's email from the users table
            const userResult = await pool.query('SELECT email FROM users WHERE user_id = $1', [complaint.student_id]);
            
            if (userResult.rows.length > 0) {
                const studentEmail = userResult.rows[0].email;
                
                // 3. Call the notification function here!
                await sendNotificationEmail(
                    studentEmail, 
                    `Ticket Update: [${ticketId}]`, 
                    `Your complaint status has been updated to: ${status}.\n\nFeedback: ${feedback}`
                );
            }
        }

        res.json({ success: true, message: 'Complaint updated successfully!' });
    } catch (err) {
        console.error('Update Error:', err);
        res.status(500).json({ error: 'Failed to update complaint.' });
    }
});

// 9. RE-ASSIGN / TRANSFER COMPLAINT TICKET TO ANOTHER STAFF ROLE
app.post('/api/admin/transfer-complaint', async (req, res) => {
    const { ticketId, newAssignee, transferReason } = req.body;
    try {
        await pool.query(
            'UPDATE complaints SET assigned_to = $1, feedback = $2 WHERE id = $3',
            [newAssignee, `Transferred to ${newAssignee}: ${transferReason}`, ticketId]
        );
        res.json({ success: true, message: 'Ticket transferred successfully!' });
    } catch (err) {
        console.error('Transfer Error:', err);
        res.status(500).json({ error: 'Failed to transfer ticket.' });
    }
});

// 10. UPDATE APPOINTMENT STATUS (APPROVE / DECLINE / RESCHEDULE)
app.post('/api/admin/update-appointment', async (req, res) => {
    const { appointmentId, status, notes } = req.body;
    try {
        await pool.query(
            'UPDATE appointments SET status = $1, reason = reason || $2 WHERE id = $3',
            [status, ` | Admin Note: ${notes}`, appointmentId]
        );
        res.json({ success: true, message: 'Appointment status updated!' });
    } catch (err) {
        console.error('Appointment Update Error:', err);
        res.status(500).json({ error: 'Failed to update appointment.' });
    }
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT} with Role-Based Routing.`);
});