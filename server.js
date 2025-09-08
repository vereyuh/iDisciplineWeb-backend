const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const sgMail = require('@sendgrid/mail');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
// For Chatbot
const { GoogleGenerativeAI } = require('@google/generative-ai');
const pdfParse = require('pdf-parse');
const fs = require('fs');
//For websocket
const http = require('http');
const { Server } = require('socket.io');
//For bulk upload of students
const multer = require('multer');
const xlsx = require('xlsx');
// Node.js 18+ has built-in fetch support

// Load environment variables
dotenv.config();
console.log("Gemini API Key loaded:", process.env.GEMINI_API_KEY ? "YES" : "NO");

// Initialize Supabase Client (Admin)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Set your SendGrid API key
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Gemini setup
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ dest: 'uploads/' });

// 1. Send Verification Email Route - UPDATED
app.post('/send-verification-email', async (req, res) => {
  const { email, name, password, token } = req.body;
  
  if (!email || !name || !password || !token) {
    return res.status(400).json({ 
      success: false, 
      message: 'Missing required fields: email, name, password, token' 
    });
  }

  try {
    console.log(`📧 Sending verification email to ${email} with token: ${token}`);
    
    const verificationLink = `${process.env.BACKEND_URL || 'http://localhost:5000'}/verify-email?token=${token}`;
    
    const msg = {
      to: email,
      from: process.env.SENDGRID_FROM_EMAIL || 'balduezaraven@gmail.com',
      subject: 'Welcome to iDiscipline - Verify Your Email (IMPORTANT)',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: rgb(39, 70, 132);">Welcome to iDiscipline!</h2>
          <p>Hi ${name},</p>
          <p>Your account has been created successfully. Here are your login credentials:</p>
          <div style="background: #f5f7fa; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <p><strong>Email:</strong> ${email}</p>
            <p><strong>Password:</strong> ${password}</p>
          </div>
          
          <div style="background: #fff3cd; border: 1px solid #ffeaa7; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <p style="color: #856404; margin: 0;"><strong>⚠️ IMPORTANT:</strong> You may receive another email from Supabase. Please use THIS verification link below instead.</p>
          </div>
          
          <p>To complete your registration, please click the verification link below:</p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${verificationLink}" style="background: rgb(39, 70, 132); color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block;">
              ✅ Verify Email Address
            </a>
          </div>
          <p>If the button doesn't work, you can copy and paste this link into your browser:</p>
          <p style="word-break: break-all; color: #666; font-size: 0.9em;">${verificationLink}</p>
          
          <div style="background: #e8f5e8; border: 1px solid #c3e6c3; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <p style="color: #155724; margin: 0;"><strong>💡 Tip:</strong> After clicking the verification link above, you can ignore any other verification emails you receive.</p>
          </div>
          
          <p style="margin-top: 30px; font-size: 0.9em; color: #666;">
            This link will expire in 24 hours. If you didn't create this account, please ignore this email.
          </p>
        </div>
      `,
      text: `Welcome to iDiscipline!\n\nHi ${name},\n\nYour account has been created successfully. Here are your login credentials:\n\nEmail: ${email}\nPassword: ${password}\n\n⚠️ IMPORTANT: You may receive another email from Supabase. Please use THIS verification link instead.\n\nTo complete your registration, please visit this verification link:\n${verificationLink}\n\n💡 Tip: After clicking the verification link above, you can ignore any other verification emails you receive.\n\nThis link will expire in 24 hours. If you didn't create this account, please ignore this email.`
    };

    await sgMail.send(msg);
    console.log(`✅ Verification email sent successfully to ${email}`);
    
    res.status(200).json({ 
      success: true, 
      message: 'Verification email sent successfully',
      verificationLink 
    });
    
  } catch (error) {
    console.error('💥 Error sending verification email:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to send verification email', 
      error: error.message 
    });
  }
});

// 2. Email Verification Route - UPDATED
app.get('/verify-email', async (req, res) => {
  const { token } = req.query;
  console.log('🔍 Verification attempt with token:', token);
  
  if (!token) {
    console.log('❌ No token provided');
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Verification Failed</title>
        <style>
          body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f5f7fa; }
          .container { max-width: 500px; margin: 0 auto; background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
          .error { color: #e74c3c; font-size: 24px; margin-bottom: 20px; }
          .message { color: #666; margin-bottom: 30px; }
          .login-btn { background: rgb(39, 70, 132); color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="error">❌ Verification Failed</div>
          <div class="message">Invalid verification link. Please contact support.</div>
          <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}" class="login-btn">Go to Login</a>
        </div>
      </body>
      </html>
    `);
  }

  try {
    console.log('✅ Processing verification with token:', token);
    
    // Find student with this verification token and check if not expired
    const { data: students, error: findError } = await supabase
      .from('students')
      .select('*')
      .eq('verification_token', token)
      .eq('verified', false);

    if (findError) {
      throw findError;
    }

    if (!students || students.length === 0) {
      throw new Error('Invalid or expired verification token');
    }

    const student = students[0];
    
    // Check if token is expired (24 hours)
    const tokenCreated = new Date(student.created_at);
    const now = new Date();
    const hoursDiff = (now - tokenCreated) / (1000 * 60 * 60);
    
    if (hoursDiff > 24) {
      throw new Error('Verification token has expired. Please request a new verification link.');
    }

    console.log('✅ Found student:', student.studentemail);

    // Mark student as verified in your students table
    const { error: updateError } = await supabase
      .from('students')
      .update({ 
        verified: true,
        verification_token: null
      })
      .eq('studentid', student.studentid);

    if (updateError) {
      throw updateError;
    }

    // ALSO confirm the user in Supabase Auth
    try {
      // First, try to find the Supabase Auth user by email
      const { data: authUsers, error: findAuthError } = await supabase.auth.admin.listUsers();
      
      if (!findAuthError && authUsers.users) {
        const authUser = authUsers.users.find(user => user.email === student.studentemail);
        
        if (authUser) {
          // Update the user's email confirmation status
          const { error: authError } = await supabase.auth.admin.updateUserById(
            authUser.id,
            { email_confirm: true }
          );
          
          if (authError) {
            console.log('⚠️ Warning: Could not update Supabase Auth user:', authError.message);
          } else {
            console.log('✅ User confirmed in Supabase Auth successfully');
          }
        } else {
          console.log('⚠️ Warning: Could not find Supabase Auth user with email:', student.studentemail);
        }
      } else {
        console.log('⚠️ Warning: Could not list Supabase Auth users:', findAuthError?.message);
      }
    } catch (authError) {
      console.log('⚠️ Warning: Could not update Supabase Auth user:', authError.message);
      // Don't throw error here - we still want to mark the student as verified
    }

    console.log('✅ Student verified successfully:', student.studentemail);

    // Show success page with clear instructions
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Email Verified Successfully</title>
        <style>
          body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f5f7fa; }
          .container { max-width: 500px; margin: 0 auto; background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
          .success { color: #27ae60; font-size: 24px; margin-bottom: 20px; }
          .message { color: #666; margin-bottom: 30px; }
          .login-btn { background: rgb(39, 70, 132); color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block; }
          .checkmark { font-size: 48px; margin-bottom: 20px; }
          .note { background: #e8f5e8; border: 1px solid #c3e6c3; padding: 15px; border-radius: 5px; margin: 20px 0; color: #155724; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="checkmark">✅</div>
          <div class="success">Email Verified Successfully!</div>
          <div class="message">
            Hi ${student.firstname || 'Student'},<br>
            Your email has been verified successfully.<br>
            You can now login to your account using your email and password.
          </div>
          <div class="note">
            <strong>💡 Note:</strong> You may receive another verification email from Supabase. You can safely ignore it since your email is already verified.
          </div>
          <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}" class="login-btn">Go to Login</a>
        </div>
      </body>
      </html>
    `);
    
  } catch (error) {
    console.error("🔥 Error verifying email:", error.message);
    // Show error page
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Verification Failed</title>
        <style>
          body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f5f7fa; }
          .container { max-width: 500px; margin: 0 auto; background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
          .error { color: #e74c3c; font-size: 24px; margin-bottom: 20px; }
          .message { color: #666; margin-bottom: 30px; }
          .login-btn { background: rgb(39, 70, 132); color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="error">❌ Verification Failed</div>
          <div class="message">${error.message}</div>
          <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}" class="login-btn">Go to Login</a>
        </div>
      </body>
      </html>
    `);
  }
});

// Handle Supabase Auth verification redirects gracefully
app.get('/auth/confirm', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Email Already Verified</title>
      <style>
        body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f5f7fa; }
        .container { max-width: 500px; margin: 0 auto; background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        .info { color: #17a2b8; font-size: 24px; margin-bottom: 20px; }
        .message { color: #666; margin-bottom: 30px; }
        .login-btn { background: rgb(39, 70, 132); color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="info">ℹ️ Email Already Verified</div>
        <div class="message">
          It looks like you clicked a verification link from Supabase Auth.<br><br>
          Your email has already been verified through our custom system.<br><br>
          You can now login to your account using your email and password.
        </div>
        <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}" class="login-btn">Go to Login</a>
      </div>
    </body>
    </html>
  `);
});



// 3.5. Resend Verification Link Route - NEW
app.post('/resend-verification-link', async (req, res) => {
  const { email, name } = req.body;
  
  if (!email || !name) {
    return res.status(400).json({ 
      success: false, 
      message: 'Missing required fields: email, name' 
    });
  }

  try {
    console.log(`📧 Resending verification email to ${email}`);
    
    // First check if current token is expired
    const { data: student, error: findError } = await supabase
      .from('students')
      .select('created_at, verification_token, verified')
      .eq('studentemail', email)
      .single();

    if (findError || !student) {
      throw new Error('Student not found');
    }

    if (student.verified) {
      return res.status(400).json({
        success: false,
        message: 'Student is already verified'
      });
    }

    // Check if current token is expired (24 hours)
    const tokenCreated = new Date(student.created_at);
    const now = new Date();
    const hoursDiff = (now - tokenCreated) / (1000 * 60 * 60);
    
    if (hoursDiff <= 24) {
      return res.status(400).json({
        success: false,
        message: `Current verification link is still valid for ${Math.ceil(24 - hoursDiff)} more hours. Please use the existing link.`
      });
    }

    console.log(`✅ Token expired, generating new verification for ${email}`);
    
    // Generate new password and token
    const newPassword = Math.random().toString(36).slice(-8);
    const newToken = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    
    // Update student with new token, password, and reset created_at for new 24-hour window
    const { error: updateError } = await supabase
      .from('students')
      .update({ 
        verification_token: newToken,
        password: newPassword,
        verified: false,
        created_at: new Date().toISOString() // Reset the 24-hour timer
      })
      .eq('studentemail', email);

    if (updateError) {
      throw updateError;
    }

    // Update Supabase Auth user password
    try {
      const { data: authUsers, error: findAuthError } = await supabase.auth.admin.listUsers();
      if (!findAuthError && authUsers.users) {
        const authUser = authUsers.users.find(user => user.email === email);
        if (authUser) {
          await supabase.auth.admin.updateUserById(authUser.id, { password: newPassword });
        }
      }
    } catch (authError) {
      console.log('⚠️ Warning: Could not update Supabase Auth user password:', authError.message);
    }

    // Send new verification email
    const verificationLink = `${process.env.BACKEND_URL || 'http://localhost:5000'}/verify-email?token=${newToken}`;
    
    const msg = {
      to: email,
      from: process.env.SENDGRID_FROM_EMAIL || 'balduezaraven@gmail.com',
      subject: 'New Verification Link - iDiscipline (IMPORTANT)',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: rgb(39, 70, 132);">New Verification Link</h2>
          <p>Hi ${name},</p>
          <p>Your previous verification link has expired. Here are your new login credentials:</p>
          <div style="background: #f5f7fa; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <p><strong>Email:</strong> ${email}</p>
            <p><strong>New Password:</strong> ${newPassword}</p>
          </div>
          
          <div style="background: #fff3cd; border: 1px solid #ffeaa7; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <p style="color: #856404; margin: 0;"><strong>⚠️ IMPORTANT:</strong> This link will expire in 24 hours.</p>
          </div>
          
          <p>To complete your registration, please click the verification link below:</p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${verificationLink}" style="background: rgb(39, 70, 132); color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block;">
              ✅ Verify Email Address
            </a>
          </div>
          <p>If the button doesn't work, you can copy and paste this link into your browser:</p>
          <p style="word-break: break-all; color: #666; font-size: 0.9em;">${verificationLink}</p>
          
          <p style="margin-top: 30px; font-size: 0.9em; color: #666;">
            This link will expire in 24 hours. If you didn't request this, please contact support.
          </p>
        </div>
      `,
      text: `New Verification Link\n\nHi ${name},\n\nYour previous verification link has expired. Here are your new login credentials:\n\nEmail: ${email}\nNew Password: ${newPassword}\n\n⚠️ IMPORTANT: This link will expire in 24 hours.\n\nTo complete your registration, please visit this verification link:\n${verificationLink}\n\nThis link will expire in 24 hours. If you didn't request this, please contact support.`
    };

    await sgMail.send(msg);
    console.log(`✅ New verification email sent successfully to ${email}`);
    
    res.status(200).json({ 
      success: true, 
      message: 'New verification link sent successfully',
      verificationLink 
    });
    
  } catch (error) {
    console.error('💥 Error resending verification email:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to resend verification email', 
      error: error.message 
    });
  }
});

// 4. Automatic Verification Checker - RESTORED
const checkAndSendPasswords = async () => {
  console.log("🔍 Checking students verification...");

  const { data: students, error } = await supabase
    .from('students')
    .select('*')
    .eq('verified', false);

  if (error) {
    console.error("🔥 Error fetching students:", error.message);
    return;
  }

  for (const student of students) {
    try {
      // Check if student has verification token (meaning they were sent a verification email)
      if (student.verification_token) {
        console.log(`📨 Sending password email to ${student.studentemail}`);

        // Send password email
        const response = await fetch(`${process.env.FRONTEND_URL || 'http://localhost:5000'}/send-password-email`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            email: student.studentemail,
            name: `${student.firstname} ${student.lastname}`,
            password: student.password,
          }),
        });

        if (response.ok) {
          // Mark password as sent
          await supabase
            .from('students')
            .update({ password_sent: true })
            .eq('studentid', student.studentid);

          console.log(`✅ Password email sent to ${student.studentemail}`);
        }
      }
    } catch (error) {
      console.error(`⚠️ Error processing student ${student.studentemail}:`, error.message);
    }
  }
};

// 5. Manual route to trigger the verification check
app.get('/check-verifications', async (req, res) => {
  await checkAndSendPasswords();
  res.send("✅ Verification check complete!");
});

// Chatbot route remains
app.post('/api/ask-handbook', async (req, res) => {
  const { question } = req.body;
  const pdfPath = '../public/docs/studenthandbook.pdf';
  try {
    const dataBuffer = fs.readFileSync(pdfPath);
    const data = await pdfParse(dataBuffer);
    const pdfText = data.text;

    const prompt = `You are a helpful assistant. Use the following student handbook to answer the question:\n\n${pdfText}\n\nQuestion: ${question}`;

    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const result = await model.generateContent(prompt);
    const answer = result.response.text();

    res.json({ answer });
  } catch (err) {
    console.error('Chatbot error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Bulk upload students from Excel
app.post('/api/bulk-upload-students', upload.single('file'), async (req, res) => {
  try {
    // 1. Read the uploaded file
    const workbook = xlsx.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const data = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);

    // 2. Map Excel column names to DB field names
    const columnMap = {
      'First Name': 'firstname',
      'Middle Name': 'middlename',
      'Last Name': 'lastname',
      'Gender': 'gender',
      'Year': 'year',
      'Section': 'section',
      'Adviser': 'adviser',
      'Student Number': 'studentno',
      'Student Email': 'studentemail',
      'Parent Guardian': 'parentguardian',
      'Parent Email': 'parentemail',
      'Address': 'address',
      'Contact No.': 'contactno'
    };

    const requiredFields = [
      'First Name',
      'Last Name',
      'Year',
      'Section',
      'Student Number',
      'Student Email'
    ];

    const errors = [];
    const validRows = [];
    const incompleteRows = [];

    // Helper function to standardize year format
    const standardizeYear = (year) => {
      if (!year) return null;
      year = year.trim();
      const yearMap = {
        '7': '7th Grade',
        '7th': '7th Grade',
        '7th grade': '7th Grade',
        '7th Grade': '7th Grade',
        '8': '8th Grade',
        '8th': '8th Grade',
        '8th grade': '8th Grade',
        '8th Grade': '8th Grade',
        '9': '9th Grade',
        '9th': '9th Grade',
        '9th grade': '9th Grade',
        '9th Grade': '9th Grade',
        '10': '10th Grade',
        '10th': '10th Grade',
        '10th grade': '10th Grade',
        '10th Grade': '10th Grade',
        '11': '11th Grade',
        '11th': '11th Grade',
        '11th grade': '11th Grade',
        '11th Grade': '11th Grade',
        '12': '12th Grade',
        '12th': '12th Grade',
        '12th grade': '12th Grade',
        '12th Grade': '12th Grade'
      };
      return yearMap[year] || year;
    };

    // Helper function to standardize section format
    const standardizeSection = (section) => {
      if (!section) return null;
      section = section.trim();
      // Remove any extra spaces and ensure proper capitalization
      return section.replace(/\s+/g, ' ').replace(/^st\.?\s*/i, 'St. ');
    };

    // Helper function to validate email format
    const isValidEmail = (email) => {
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    };

    // Helper function to validate student number format
    const isValidStudentNumber = (studentNo) => {
      return /^\d{4}-\d{5}$/.test(studentNo);
    };

    // Helper function to generate verification token
    const generateVerificationToken = () => {
      return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    };

    data.forEach((row, idx) => {
      const rowErrors = [];
      const processedRow = {};

      // Check for missing required fields
      const missingFields = requiredFields.filter(col => !row[col]);
      if (missingFields.length > 0) {
        errors.push({
          row: idx + 2,
          errors: [`Missing required fields: ${missingFields.join(', ')}`],
          data: row
        });
        return; // Do not process further or insert
      }

      // Process and validate each field
      for (const [excelCol, dbCol] of Object.entries(columnMap)) {
        let value = row[excelCol];
        if (!value) {
          processedRow[dbCol] = null;
          continue;
        }
        value = value.toString().trim();
        switch (excelCol) {
          case 'Year':
            value = standardizeYear(value);
            if (value && !/^(7|8|9|10|11|12)th Grade$/.test(value)) {
              rowErrors.push(`Invalid year format: ${value}`);
            }
            break;
          case 'Section':
            value = standardizeSection(value);
            if (value && !/^St\.\s+[A-Za-z]+$/.test(value)) {
              rowErrors.push(`Invalid section format: ${value}`);
            }
            break;
          case 'Student Number':
            if (!isValidStudentNumber(value)) {
              rowErrors.push(`Invalid student number format: ${value}`);
            }
            break;
          case 'Student Email':
            if (!isValidEmail(value)) {
              rowErrors.push(`Invalid email format: ${value}`);
            }
            break;
          case 'First Name':
          case 'Last Name':
            value = value.split(' ')
              .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
              .join(' ');
            break;
        }
        processedRow[dbCol] = value;
      }
      
      // Generate password and verification token for each student
      processedRow.password = Math.random().toString(36).slice(-8);
      processedRow.verification_token = generateVerificationToken();
      processedRow.roles = 'student';
      processedRow.verified = false; // Mark as unverified initially
      
      // Check for optional fields
      const optionalFields = ['Middle Name', 'Gender', 'Adviser', 'Parent Guardian', 'Parent Email', 'Address', 'Contact No.'];
      const missingOptional = optionalFields.filter(field => !row[field]);
      processedRow.hasincompleteprofile = missingOptional.length > 0;
      
      if (rowErrors.length > 0) {
        errors.push({
          row: idx + 2,
          errors: rowErrors,
          data: row
        });
      } else if (processedRow.hasincompleteprofile) {
        incompleteRows.push(processedRow);
      } else {
        validRows.push(processedRow);
      }
    });

    // 3. Insert valid rows in bulk
    let addedCount = 0;
    let incompleteCount = 0;
    let addedList = [];
    let incompleteList = [];
    let verificationEmailsSent = 0;
    let verificationEmailErrors = [];

    // Helper to insert rows with fallback to per-row insert on error
    async function safeInsert(rows, isIncomplete = false) {
      let successList = [];
      let failList = [];
      if (rows.length === 0) return { successList, failList };
      
      // Try batch insert first
      const { data, error } = await supabase.from('students').insert(rows).select();
      if (!error) {
        successList = (data || []).map(s => ({ 
          firstname: s.firstname, 
          lastname: s.lastname, 
          studentno: s.studentno,
          studentemail: s.studentemail,
          verification_token: s.verification_token,
          password: s.password
        }));
        return { successList, failList };
      }
      
      // If batch insert fails, try one by one
      for (const row of rows) {
        const { data: singleData, error: singleError } = await supabase.from('students').insert([row]).select();
        if (!singleError && singleData && singleData.length > 0) {
          successList.push({ 
            firstname: singleData[0].firstname, 
            lastname: singleData[0].lastname, 
            studentno: singleData[0].studentno,
            studentemail: singleData[0].studentemail,
            verification_token: singleData[0].verification_token,
            password: singleData[0].password
          });
        } else {
          failList.push({
            firstname: row.firstname,
            lastname: row.lastname,
            studentno: row.studentno,
            error: singleError ? singleError.message : 'Unknown error',
            isIncomplete
          });
        }
      }
      return { successList, failList };
    }

    // Insert valid students
    const validResult = await safeInsert(validRows, false);
    addedList = validResult.successList;
    addedCount = addedList.length;
    
    // Insert incomplete students
    const incompleteResult = await safeInsert(incompleteRows, true);
    incompleteList = incompleteResult.successList;
    incompleteCount = incompleteList.length;
    
    // Collect all errors
    if (validResult.failList.length > 0) {
      validResult.failList.forEach(f => {
        errors.push({ row: 'single', errors: [f.error], data: f });
      });
    }
    if (incompleteResult.failList.length > 0) {
      incompleteResult.failList.forEach(f => {
        errors.push({ row: 'single', errors: [f.error], data: f });
      });
    }

    // 4. Send verification emails to all successfully added students
    console.log(`📧 Sending verification emails to ${addedList.length + incompleteList.length} students...`);
    
    const allStudents = [...addedList, ...incompleteList];
    
    for (const student of allStudents) {
      try {
        // First, create the Supabase Auth user
        console.log(`🔐 Creating Supabase Auth user for ${student.studentemail}...`);
        
        const { data: authData, error: authError } = await supabase.auth.admin.createUser({
          email: student.studentemail,
          password: student.password,
          email_confirm: false, // User must verify email
          user_metadata: {
            firstname: student.firstname,
            lastname: student.lastname,
            studentno: student.studentno,
            roles: 'student'
          }
        });

        if (authError) {
          console.log(`❌ Failed to create Supabase Auth user for ${student.studentemail}:`, authError.message);
          verificationEmailErrors.push({
            email: student.studentemail,
            error: `Auth user creation failed: ${authError.message}`
          });
          continue; // Skip to next student
        }

        console.log(`✅ Supabase Auth user created for ${student.studentemail}`);

        // Now send verification email
        const response = await fetch(`${process.env.BACKEND_URL || 'http://localhost:5000'}/send-verification-email`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            email: student.studentemail,
            name: `${student.firstname} ${student.lastname}`,
            password: student.password,
            token: student.verification_token,
          }),
        });

        if (response.ok) {
          verificationEmailsSent++;
          console.log(`✅ Verification email sent to ${student.studentemail}`);
        } else {
          const errorData = await response.json();
          verificationEmailErrors.push({
            email: student.studentemail,
            error: errorData.message || 'Failed to send verification email'
          });
          console.log(`❌ Failed to send verification email to ${student.studentemail}:`, errorData.message);
        }
      } catch (error) {
        verificationEmailErrors.push({
          email: student.studentemail,
          error: error.message
        });
        console.log(`❌ Error processing ${student.studentemail}:`, error.message);
      }
    }

    // 5. Clean up the uploaded file
    fs.unlinkSync(req.file.path);

    // 6. Send comprehensive response
    res.json({
      success: true,
      added: addedCount,
      incomplete: incompleteCount,
      addedList,
      incompleteList,
      verificationEmailsSent,
      verificationEmailErrors: verificationEmailErrors.length > 0 ? verificationEmailErrors : undefined,
      errors: errors.length > 0 ? errors : undefined,
      summary: `Successfully uploaded ${addedCount + incompleteCount} students and sent ${verificationEmailsSent} verification emails.`
    });

  } catch (error) {
    console.error('Error in bulk upload:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 6. Send custom parent notification email
app.post('/send-parent-email', async (req, res) => {
  const { parentEmail, parentName, studentName, violationCategory, violationType, timeReported, notes, status } = req.body;

  if (!parentEmail || !parentName || !studentName) {
    return res.status(400).json({ success: false, message: 'Missing required fields.' });
  }

  const msg = {
    to: parentEmail,
    from: process.env.SENDGRID_FROM_EMAIL || 'balduezaraven@gmail.com',
    subject: `Notification: Disciplinary Incident for ${studentName}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color:rgb(39, 70, 132);">Disciplinary Notification</h2>
        <p>Dear ${parentName},</p>
        <p>This is to inform you that your child, <strong>${studentName}</strong>, has been reported for a disciplinary incident at school. Please see the details below:</p>
        <div style="background: #f5f7fa; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <p><strong>Status:</strong> ${status || 'N/A'}</p>
          <p><strong>Violation Category:</strong> ${violationCategory || 'N/A'}</p>
          <p><strong>Violation Type:</strong> ${violationType || 'N/A'}</p>
          <p><strong>Time Reported:</strong> ${timeReported || 'N/A'}</p>
          <p><strong>Notes:</strong> ${notes || 'N/A'}</p>
        </div>
        <p>If you have any questions or concerns, please contact the school office.</p>
        <p style="margin-top: 30px; font-size: 0.9em; color: #666;">This is an automated message. Please do not reply directly to this email.</p>
      </div>
    `,
    text: `Dear ${parentName},\n\nThis is to inform you that your child, ${studentName}, has been reported for a disciplinary incident at school.\n\nStatus: ${status || 'N/A'}\nViolation Category: ${violationCategory || 'N/A'}\nViolation Type: ${violationType || 'N/A'}\nTime Reported: ${timeReported || 'N/A'}\nNotes: ${notes || 'N/A'}\n\nIf you have any questions or concerns, please contact the school office.\n\nThis is an automated message. Please do not reply directly to this email.`
  };

  try {
    await sgMail.send(msg);
    res.status(200).json({ success: true, message: 'Parent notification email sent.' });
  } catch (error) {
    console.error('💥 Error sending parent notification email:', error);
    res.status(500).json({ success: false, message: 'Failed to send parent notification email.', error: error.message });
  }
});

// Add new endpoint for personality test analysis
app.post('/api/analyze-personality', async (req, res) => {
  const { answers, violations } = req.body;
  
  try {
    // Analyze violation patterns
    const violationPatterns = analyzeViolationPatterns(violations);
    
    const prompt = `As a professional student counselor, analyze these personality test answers and recent violations to provide a concise, professional analysis focusing on behavioral patterns and potential areas for improvement. Keep the analysis brief but insightful, focusing on key personality traits and behavioral tendencies that may be relevant for student discipline and development.

Personality Test Answers: ${JSON.stringify(answers)}
Recent Violations: ${JSON.stringify(violations)}
Violation Patterns: ${JSON.stringify(violationPatterns)}

Provide a brief analysis (2-3 sentences) that highlights:
1. Key personality traits
2. Recent behavioral patterns based on violations, specifically noting:
   - Frequency of violations
   - Types of violations (Minor/Major Type A/Major Type B)
   - Any patterns in violation categories
   - Recent trends in behavior
3. Areas for positive development
4. Specific recommendations based on violation history and patterns
5. Suggested interventions based on violation types`;

    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const result = await model.generateContent(prompt);
    const analysis = result.response.text();

    res.json({ analysis });
  } catch (err) {
    console.error('Personality analysis error:', err);
    res.status(500).json({ error: err.message });
  }
});
// Helper function to analyze violation patterns
function analyzeViolationPatterns(violations) {
  if (!violations || violations.length === 0) {
    return {
      totalViolations: 0,
      patterns: "No violations recorded"
    };
  }

  // Count violations by category
  const categoryCount = {
    "Minor Offenses": 0,
    "Major Type A": 0,
    "Major Type B": 0
  };

  // Count violations by type
  const typeCount = {};
  
  // Track violations by month
  const monthlyViolations = {};
  
  // Track most recent violations
  const recentViolations = violations
    .sort((a, b) => new Date(b.datereported) - new Date(a.datereported))
    .slice(0, 5);

  violations.forEach(violation => {
    // Count by category
    if (categoryCount.hasOwnProperty(violation.violationcategory)) {
      categoryCount[violation.violationcategory]++;
    }

    // Count by type
    typeCount[violation.violationtype] = (typeCount[violation.violationtype] || 0) + 1;

    // Track by month
    const date = new Date(violation.datereported);
    const monthKey = `${date.getFullYear()}-${date.getMonth() + 1}`;
    monthlyViolations[monthKey] = (monthlyViolations[monthKey] || 0) + 1;
  });

  // Calculate trends
  const monthlyTrends = Object.entries(monthlyViolations)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, count]) => ({ month, count }));

  // Find most frequent violation types
  const mostFrequentTypes = Object.entries(typeCount)
    .sort(([,a], [,b]) => b - a)
    .slice(0, 3)
    .map(([type, count]) => ({ type, count }));

  return {
    totalViolations: violations.length,
    categoryBreakdown: categoryCount,
    mostFrequentTypes,
    monthlyTrends,
    recentViolations: recentViolations.map(v => ({
      type: v.violationtype,
      category: v.violationcategory,
      date: v.datereported
    })),
    patterns: {
      hasEscalatingSeverity: checkEscalatingSeverity(violations),
      hasRepeatedViolations: checkRepeatedViolations(violations),
      hasRecentViolations: recentViolations.length > 0
    }
  };
}

// Helper function to check if violations are escalating in severity
function checkEscalatingSeverity(violations) {
  const severityOrder = {
    "Minor Offenses": 1,
    "Major Type A": 2,
    "Major Type B": 3
  };

  const sortedViolations = violations
    .sort((a, b) => new Date(a.datereported) - new Date(b.datereported))
    .map(v => severityOrder[v.violationcategory]);

  for (let i = 1; i < sortedViolations.length; i++) {
    if (sortedViolations[i] > sortedViolations[i-1]) {
      return true;
    }
  }
  return false;
}

// Helper function to check for repeated violations
function checkRepeatedViolations(violations) {
  const typeCount = {};
  for (const violation of violations) {
    typeCount[violation.violationtype] = (typeCount[violation.violationtype] || 0) + 1;
    if (typeCount[violation.violationtype] > 1) {
      return true;
    }
  }
  return false;
}

// New endpoint for AI suggestions for reports
app.post('/api/report-suggestion', async (req, res) => {
  const { category, summary } = req.body;
  try {
    // Load handbook text (assuming PDF is in public/docs/studenthandbook.pdf)
    const path = require('path');
    const pdfPath = path.join(__dirname, '../public/docs/studenthandbook.pdf');
    const dataBuffer = fs.readFileSync(pdfPath);
    const data = await pdfParse(dataBuffer);
    const handbookText = data.text;

    // Compose prompt
    const prompt = `You are a helpful school assistant. Based on the following student handbook and the provided report summary, give a concise (2-3 sentences), practical suggestion for the "${category}" category. Reference the handbook where relevant, and keep the language simple and actionable.\n\nStudent Handbook:\n${handbookText}\n\nReport Summary:\n${summary}\n\nSuggestion:`;

    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const result = await model.generateContent(prompt);
    const suggestion = result.response.text();

    res.json({ suggestion });
  } catch (err) {
    console.error('AI suggestion error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- SOCKET.IO REAL-TIME MESSAGING SETUP ---

// Create HTTP server and attach Socket.io
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // For development; restrict to your frontend URL in production
    methods: ["GET", "POST"]
  }
});

// Socket.io event handling
io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  // Join a room for a specific violation
  socket.on('join_violation_room', (violationId) => {
    socket.join(violationId);
    console.log(`Socket ${socket.id} joined room ${violationId}`);
  });

  // Listen for new messages
  socket.on('send_message', async (data) => {
    console.log('Attempting to save message:', data);
    try {
      // Validate required fields
      if (!data.violationId || !data.sender || !data.sender_id || !data.time_sent || !data.message) {
        throw new Error('Missing required message fields');
      }
      // Save to DB
      console.log('Data to insert:', {
        violationid: data.violationId,
        sender: data.sender,
        sender_id: data.sender_id,
        time_sent: data.time_sent,
        message: data.message
      });
      const { error } = await supabase.from('messages').insert([{
        violationid: data.violationId,
        sender: data.sender,
        sender_id: data.sender_id,
        time_sent: data.time_sent,
        message: data.message
      }]);
      if (error) throw error;
      console.log('Message saved!');
    } catch (err) {
      console.error('Error saving message to DB:', err);
    }
    // Broadcast to everyone in the same room (except sender)
    socket.to(data.violationId).emit('receive_message', data);
  });

  // Incident report chat room
  socket.on('join_incident_room', (incidentId) => {
    console.log(`Socket ${socket.id} attempting to join incident room ${incidentId}`);
    socket.join(incidentId);
    console.log(`✅ Socket ${socket.id} joined incident room ${incidentId}`);
    // Log current sockets in the room
    const socketsInRoom = io.sockets.adapter.rooms.get(incidentId);
    console.log('Current sockets in room:', socketsInRoom ? Array.from(socketsInRoom) : []);
  });

  socket.on('send_message_ir', async (data) => {
    console.log('Received send_message_ir:', data);
    try {
      if (!data.incidentreport_id || !data.sender || !data.sender_id || !data.time_sent || !data.message) {
        throw new Error('Missing required message fields');
      }
      console.log('Saving incident message to DB:', {
        incidentreport_id: data.incidentreport_id,
        sender: data.sender,
        sender_id: data.sender_id,
        time_sent: data.time_sent,
        message: data.message
      });
      const { error } = await supabase.from('messages_ir').insert([{
        incidentreport_id: data.incidentreport_id,
        sender: data.sender,
        sender_id: data.sender_id,
        time_sent: data.time_sent,
        message: data.message
      }]);
      if (error) throw error;
      console.log('✅ Incident message saved successfully!');
    } catch (err) {
      console.error('❌ Error saving incident message to DB:', err);
    }
    // Log before broadcasting
    const socketsInRoom = io.sockets.adapter.rooms.get(data.incidentreport_id);
    console.log('Broadcasting to room:', data.incidentreport_id, 'Sockets:', socketsInRoom ? Array.from(socketsInRoom) : []);
    // Broadcast to ALL sockets in the room (including sender)
    io.to(data.incidentreport_id).emit('receive_message_ir', data);
    console.log('✅ Message broadcasted to room');
  });

  socket.on('disconnect', () => {
    console.log('A user disconnected:', socket.id);
  });
});

// 6. Password Reset Request Route - NEW
app.post('/request-password-reset', async (req, res) => {
  const { email } = req.body;
  
  if (!email) {
    return res.status(400).json({ 
      success: false, 
      message: 'Email is required' 
    });
  }

  try {
    console.log(`🔐 Password reset requested for: ${email}`);
    
    // Check if email exists in either users or students table
    const [adminResult, studentResult] = await Promise.all([
      supabase.from("users").select("email, firstname, lastname").eq("email", email).single(),
      supabase.from("students").select("studentemail, firstname, lastname").eq("studentemail", email).single()
    ]);
    
    let userData = null;
    let userType = null;
    
    if (adminResult.data && !adminResult.error) {
      userData = adminResult.data;
      userType = 'admin';
    } else if (studentResult.data && !studentResult.error) {
      userData = studentResult.data;
      userType = 'student';
    } else {
      return res.status(404).json({
        success: false,
        message: 'Email not found. Please check your email address.'
      });
    }

    // Generate password reset token
    const resetToken = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    
    // Set expiration (1 hour from now)
    const resetTokenExpires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    
    // Update the appropriate table with reset token
    if (userType === 'admin') {
      const { error: updateError } = await supabase
        .from('users')
        .update({ 
          password_reset_token: resetToken,
          password_reset_token_expires: resetTokenExpires
        })
        .eq('email', email);
      
      if (updateError) throw updateError;
    } else {
      const { error: updateError } = await supabase
        .from('students')
        .update({ 
          password_reset_token: resetToken,
          password_reset_token_expires: resetTokenExpires
        })
        .eq('studentemail', email);
      
      if (updateError) throw updateError;
    }

    // Send password reset email via SendGrid
    const resetLink = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/reset-password-confirm?token=${resetToken}`;
    
    const msg = {
      to: email,
      from: process.env.SENDGRID_FROM_EMAIL || 'balduezaraven@gmail.com',
      subject: 'Password Reset Request - iDiscipline',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: rgb(39, 70, 132);">Password Reset Request</h2>
          <p>Hi ${userData.firstname} ${userData.lastname},</p>
          <p>We received a request to reset your password for your iDiscipline account.</p>
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="${resetLink}" style="background: rgb(39, 70, 132); color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block;">
              🔐 Reset Password
            </a>
          </div>
          
          <p>If the button doesn't work, you can copy and paste this link into your browser:</p>
          <p style="word-break: break-all; color: #666; font-size: 0.9em;">${resetLink}</p>
          
          <div style="background: #fff3cd; border: 1px solid #ffeaa7; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <p style="color: #856404; margin: 0;"><strong>⚠️ IMPORTANT:</strong> This link will expire in 1 hour. If you didn't request this password reset, please ignore this email.</p>
          </div>
          
          <p style="margin-top: 30px; font-size: 0.9em; color: #666;">
            If you have any questions, please contact the school office.
          </p>
        </div>
      `,
      text: `Password Reset Request\n\nHi ${userData.firstname} ${userData.lastname},\n\nWe received a request to reset your password for your iDiscipline account.\n\nTo reset your password, please visit this link:\n${resetLink}\n\n⚠️ IMPORTANT: This link will expire in 1 hour. If you didn't request this password reset, please ignore this email.\n\nIf you have any questions, please contact the school office.`
    };

    await sgMail.send(msg);
    console.log(`✅ Password reset email sent successfully to ${email}`);
    
    res.status(200).json({ 
      success: true, 
      message: 'Password reset instructions sent to your email!',
      resetLink 
    });
    
  } catch (error) {
    console.error('💥 Error processing password reset request:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to process password reset request', 
      error: error.message 
    });
  }
});

// 7. Password Reset Confirmation Route - NEW
app.post('/confirm-password-reset', async (req, res) => {
  const { token, newPassword } = req.body;
  
  if (!token || !newPassword) {
    return res.status(400).json({ 
      success: false, 
      message: 'Token and new password are required' 
    });
  }

  try {
    console.log(`🔐 Processing password reset with token: ${token}`);
    
    // Check if token exists and is not expired in either table
    const [adminResult, studentResult] = await Promise.all([
      supabase.from("users").select("*").eq("password_reset_token", token).single(),
      supabase.from("students").select("*").eq("password_reset_token", token).single()
    ]);
    
    let userData = null;
    let userType = null;
    
    if (adminResult.data && !adminResult.error) {
      userData = adminResult.data;
      userType = 'admin';
    } else if (studentResult.data && !studentResult.error) {
      userData = studentResult.data;
      userType = 'student';
    } else {
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired reset token'
      });
    }

    // Check if token is expired
    const tokenExpires = new Date(userData.password_reset_token_expires);
    const now = new Date();
    
    if (now > tokenExpires) {
      return res.status(400).json({
        success: false,
        message: 'Reset token has expired. Please request a new password reset.'
      });
    }

    // Update password in the appropriate table
    if (userType === 'admin') {
      const { error: updateError } = await supabase
        .from('users')
        .update({ 
          password: newPassword,
          password_reset_token: null,
          password_reset_token_expires: null
        })
        .eq('email', userData.email);
      
      if (updateError) throw updateError;
    } else {
      const { error: updateError } = await supabase
        .from('students')
        .update({ 
          password: newPassword,
          password_reset_token: null,
          password_reset_token_expires: null
        })
        .eq('studentemail', userData.studentemail);
      
      if (updateError) throw updateError;
    }

    // Also update Supabase Auth user password if possible
    try {
      if (userType === 'admin') {
        const { data: authUsers, error: findAuthError } = await supabase.auth.admin.listUsers();
        if (!findAuthError && authUsers.users) {
          const authUser = authUsers.users.find(user => user.email === userData.email);
          if (authUser) {
            await supabase.auth.admin.updateUserById(authUser.id, { password: newPassword });
          }
        }
      } else {
        const { data: authUsers, error: findAuthError } = await supabase.auth.admin.listUsers();
        if (!findAuthError && authUsers.users) {
          const authUser = authUsers.users.find(user => user.email === userData.studentemail);
          if (authUser) {
            await supabase.auth.admin.updateUserById(authUser.id, { password: newPassword });
          }
        }
      }
    } catch (authError) {
      console.log('⚠️ Warning: Could not update Supabase Auth user password:', authError.message);
    }

    console.log(`✅ Password updated successfully for ${userType}: ${userData.email || userData.studentemail}`);
    
    res.status(200).json({ 
      success: true, 
      message: 'Password updated successfully! You can now login with your new password.' 
    });
    
  } catch (error) {
    console.error('💥 Error confirming password reset:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to update password', 
      error: error.message 
    });
  }
});

// 🚀 Run the server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
