const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const helmet = require('helmet');
const sgMail = require('@sendgrid/mail');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
// For Chatbot
const Anthropic = require('@anthropic-ai/sdk');
const pdfParse = require('pdf-parse');
const fs = require('fs');
//For websocket
const http = require('http');
const { Server } = require('socket.io');
//For bulk upload of students
const multer = require('multer');
const xlsx = require('xlsx');
// Node.js 18+ has built-in fetch support
const fetch = require('node-fetch');

// Load environment variables
dotenv.config();

// Smart backend URL detection
const getBackendUrl = () => {
  // Check if we're running locally (development)
  if (process.env.NODE_ENV === 'development' || 
      process.env.NODE_ENV === undefined || 
      process.env.PORT === undefined) {
    return 'http://localhost:5000';
  }
  // Production environment
  return process.env.BACKEND_URL || 'https://idisciplineweb-backend.onrender.com';
};

const BACKEND_URL = getBackendUrl();
console.log(`🌐 Backend URL: ${BACKEND_URL}`);
console.log("Anthropic API Key loaded:", process.env.ANTHROPIC_API_KEY ? "YES" : "NO");

// Initialize Supabase Client (Admin)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Set your SendGrid API key
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Semaphore SMS setup
const SEMAPHORE_API_KEY = process.env.SEMAPHORE_API_KEY;
const SEMAPHORE_SENDER_NAME = process.env.SEMAPHORE_SENDER_NAME || 'iDiscipline';

// Expo Push Notifications setup
const EXPO_ACCESS_TOKEN = process.env.EXPO_ACCESS_TOKEN;
const EXPO_URL = 'https://exp.host/--/api/v2/push/send';

// SendGrid sender defaults (support both FROM_NAME and SENDER_NAME)
const SENDGRID_FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || 'idiscipline2025@gmail.com';
const SENDGRID_FROM_NAME = process.env.SENDGRID_FROM_NAME || process.env.SENDGRID_SENDER_NAME || 'iDiscipline';

// Function to send SMS via Semaphore
async function sendSMS(phoneNumber, message) {
  try {
    console.log('📱 Attempting to send SMS to:', phoneNumber);
    console.log('📝 Message length:', message.length);
    console.log('🔑 API Key available:', !!SEMAPHORE_API_KEY);
    console.log('📱 Sender name:', SEMAPHORE_SENDER_NAME);
    
    if (!SEMAPHORE_API_KEY) {
      console.error('❌ SEMAPHORE_API_KEY is not set!');
      return { success: false, error: 'SMS service not configured. Missing API key.' };
    }
    
    // Semaphore API expects parameters as query parameters, not in body
    const params = new URLSearchParams({
      apikey: SEMAPHORE_API_KEY,
      number: phoneNumber,
      message: message,
      sendername: SEMAPHORE_SENDER_NAME
    });
    
    const response = await fetch(`https://api.semaphore.co/api/v4/messages?${params}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      }
    });

    const result = await response.json();
    console.log('📊 Semaphore API Response:', result);
    
    // Check if the response contains an error message
    if (result && result.number && result.number.includes('The number format is invalid')) {
      console.error('❌ Invalid phone number format:', phoneNumber);
      return { success: false, error: 'Invalid phone number format. Please check the contact number.' };
    }
    
    if (response.ok && result && !result.number) {
      console.log('✅ SMS sent successfully:', result);
      return { success: true, data: result };
    } else {
      console.error('❌ SMS sending failed:', result);
      return { success: false, error: result.message || 'Failed to send SMS' };
    }
  } catch (error) {
    console.error('💥 Error sending SMS:', error);
    return { success: false, error: error.message };
  }
}

// Function to send Expo push notifications
async function sendExpoPush(messages) {
  try {
    if (!EXPO_ACCESS_TOKEN) {
      console.error('❌ EXPO_ACCESS_TOKEN is not set!');
      return { success: false, error: 'Push notification service not configured. Missing Expo access token.' };
    }

    console.log('📱 Sending push notification to Expo:', messages.length, 'messages');
    
    const response = await fetch(EXPO_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${EXPO_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(messages)
    });

    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }

    if (!response.ok) {
      throw new Error(`Expo push failed: ${text}`);
    }

    console.log('✅ Push notification sent successfully:', json);
    return { success: true, data: json };
  } catch (error) {
    console.error('💥 Error sending push notification:', error);
    return { success: false, error: error.message };
  }
}

// Function to log push notification attempts
async function logPushNotification(userId, title, body, category, type, pushTokens, expoResponse, status = 'sent') {
  try {
    const { error } = await supabase
      .from('push_notification_logs')
      .insert([{
        user_id: userId,
        title,
        body,
        category,
        type,
        push_tokens: pushTokens,
        expo_response: expoResponse,
        status,
        sent_at: new Date().toISOString()
      }]);

    if (error) {
      console.error('❌ Error logging push notification:', error);
    } else {
      console.log('✅ Push notification logged successfully');
    }
  } catch (error) {
    console.error('💥 Error in logPushNotification:', error);
  }
}

// Anthropic setup
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Simple rate limiting to prevent API overuse
const requestCounts = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 10; // Conservative limit

function checkRateLimit() {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW;
  
  // Clean old entries
  for (const [timestamp, count] of requestCounts.entries()) {
    if (timestamp < windowStart) {
      requestCounts.delete(timestamp);
    }
  }
  
  // Count current requests
  const currentRequests = Array.from(requestCounts.values()).reduce((sum, count) => sum + count, 0);
  
  if (currentRequests >= MAX_REQUESTS_PER_WINDOW) {
    throw new Error('Rate limit exceeded. Please wait before making another request.');
  }
  
  // Record this request
  const currentMinute = Math.floor(now / 60000) * 60000;
  requestCounts.set(currentMinute, (requestCounts.get(currentMinute) || 0) + 1);
}

const app = express();

// Force HTTPS redirect in production
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && req.header('x-forwarded-proto') !== 'https') {
    res.redirect(`https://${req.header('host')}${req.url}`);
  } else {
    next();
  }
});

// Security headers configuration
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdn.jsdelivr.net"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdn.jsdelivr.net"],
      imgSrc: ["'self'", "data:", "https:", "blob:"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdn.jsdelivr.net"],
      connectSrc: ["'self'", "https://api.supabase.co", "https://api.anthropic.com", "wss:", "ws:"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameAncestors: ["'none'"], // Modern replacement for X-Frame-Options
      workerSrc: ["'self'", "blob:"],
      formAction: ["'self'"],
      baseUri: ["'self'"],
      manifestSrc: ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false, // Disable for compatibility with some APIs
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  },
  referrerPolicy: {
    policy: "strict-origin-when-cross-origin"
  },
  permissionsPolicy: {
    camera: [],
    microphone: [],
    geolocation: [],
    interestCohort: []
  }
}));

// Additional explicit security headers (backup)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
  next();
});

app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/api/health', (req, res) => {
  const path = require('path');
  const pdfPath = path.join(__dirname, '../public/docs/studenthandbook.pdf');
  const altPaths = [
    path.join(__dirname, 'public/docs/studenthandbook.pdf'),
    path.join(process.cwd(), 'public/docs/studenthandbook.pdf'),
    path.join(process.cwd(), 'docs/studenthandbook.pdf')
  ];
  
  let pdfStatus = 'NOT FOUND';
  let pdfPathFound = null;
  
  if (fs.existsSync(pdfPath)) {
    pdfStatus = 'FOUND';
    pdfPathFound = pdfPath;
  } else {
    for (const altPath of altPaths) {
      if (fs.existsSync(altPath)) {
        pdfStatus = 'FOUND';
        pdfPathFound = altPath;
        break;
      }
    }
  }
  
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ? 'SET' : 'NOT SET',
    environment: process.env.NODE_ENV || 'development',
    pdfStatus: pdfStatus,
    pdfPath: pdfPathFound,
    workingDirectory: process.cwd(),
    serverDirectory: __dirname
  });
});

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
    
    const verificationLink = `${process.env.BACKEND_URL || 'https://idisciplineweb-backend.onrender.com'}/verify-email?token=${token}`;
    
    const msg = {
      to: email,
      from: { email: SENDGRID_FROM_EMAIL, name: SENDGRID_FROM_NAME },
      subject: 'MIPSS Student Account Verification - Action Required',
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>MIPSS Student Account Verification</title>
        </head>
        <body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f5f5f5;">
          <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff;">
            <!-- Header -->
            <div style="background-color: #274684; color: white; padding: 20px; text-align: center;">
              <h2 style="margin: 0; font-size: 24px; font-weight: bold;">MARY IMMACULATE PARISH SPECIAL SCHOOL INC.</h2>
              <p style="margin: 10px 0 0 0; font-size: 14px;">Avocado Drive, Agro Homes 1, Moonwalk Village, Talon Singko, Las Piñas City, Philippines 1747</p>
              <p style="margin: 5px 0 0 0; font-size: 12px;">Email: registrar@mipss.edu.ph | accounting@mipss.edu.ph | hrdm@mipss.edu.ph</p>
              <p style="margin: 5px 0 0 0; font-size: 12px;">Website: mipss.edu.ph</p>
            </div>
            
            <!-- Main Content -->
            <div style="padding: 40px 30px; background-color: #ffffff;">
              <h1 style="color: #274684; font-size: 28px; font-weight: bold; margin: 0 0 20px 0; text-align: center;">Student Account Verification</h1>
              
              <p style="color: #333333; font-size: 16px; line-height: 1.5; margin: 0 0 20px 0;">Hello ${name},</p>
              
              <p style="color: #333333; font-size: 16px; line-height: 1.5; margin: 0 0 20px 0;">We received a request to verify your student account for the iDiscipline system. If you didn't make this request, you can safely ignore this email.</p>
              
              <div style="background-color: #f8f9fa; border: 1px solid #e9ecef; border-radius: 8px; padding: 20px; margin: 20px 0;">
                <h3 style="color: #274684; font-size: 18px; margin: 0 0 15px 0;">Your Login Credentials:</h3>
                <p style="color: #333333; font-size: 14px; margin: 5px 0;"><strong>Email:</strong> ${email}</p>
                <p style="color: #333333; font-size: 14px; margin: 5px 0;"><strong>Password:</strong> ${password}</p>
              </div>
              
              <div style="text-align: center; margin: 30px 0;">
                <a href="${verificationLink}" style="background-color: #274684; color: #ffffff; padding: 15px 40px; text-decoration: none; border-radius: 5px; display: inline-block; font-weight: bold; font-size: 16px;">
                  Verify Your Account
                </a>
              </div>
              
              <p style="color: #666666; font-size: 14px; text-align: center; margin: 20px 0;">Or copy and paste this link into your browser:</p>
              <p style="color: #666666; font-size: 12px; word-break: break-all; background-color: #f8f9fa; padding: 10px; border-radius: 4px; margin: 10px 0;">${verificationLink}</p>
              
              <div style="background-color: #fff3cd; border: 1px solid #ffeaa7; border-radius: 5px; padding: 15px; margin: 20px 0;">
                <p style="color: #856404; margin: 0; font-size: 14px;"><strong>Security Notice:</strong> This link will expire in 24 hours for your security. If you need more time, please request another verification link.</p>
              </div>
              
              <p style="color: #333333; font-size: 14px; line-height: 1.5; margin: 20px 0;">If you have any questions or need assistance, please contact our support team.</p>
              
              <p style="color: #333333; font-size: 14px; line-height: 1.5; margin: 20px 0 0 0;">Best regards,<br>The iDiscipline Team</p>
            </div>
            
            <!-- Footer -->
            <div style="background-color: #f8f9fa; border-top: 3px solid #274684; padding: 15px; text-align: center;">
              <p style="margin: 0; color: #666; font-size: 12px;">© 2025 MIPSS — "God-Centered, Academically Excellent and Socially Responsible community of learners."</p>
            </div>
          </div>
        </body>
        </html>
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

// 2.5. Admin Email Verification Route - NEW
app.get('/verify-admin-email', async (req, res) => {
  const { token } = req.query;
  console.log('🔍 Admin verification attempt with token:', token);
  
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
    console.log('✅ Processing admin verification with token:', token);
    
    // Find admin with this verification token and check if not expired
    const { data: admins, error: findError } = await supabase
      .from('users')
      .select('*')
      .eq('token_verification', token)
      .eq('status', 'inactive'); // Check for inactive status (unverified)

    if (findError) {
      throw findError;
    }

    if (!admins || admins.length === 0) {
      throw new Error('Invalid or expired verification token');
    }

    const admin = admins[0];
    
    // Check if token is expired (24 hours)
    const tokenCreated = new Date(admin.created_at);
    const now = new Date();
    const hoursDiff = (now - tokenCreated) / (1000 * 60 * 60);
    
    if (hoursDiff > 24) {
      throw new Error('Verification token has expired. Please request a new verification link.');
    }

    console.log('✅ Found admin:', admin.email);

    // Mark admin as verified and active in your users table
    const { error: updateError } = await supabase
      .from('users')
      .update({ 
        status: 'active',
        token_verification: null
      })
      .eq('id', admin.id);

    if (updateError) {
      throw updateError;
    }

    // ALSO confirm the user in Supabase Auth
    try {
      // First, try to find the Supabase Auth user by email
      const { data: authUsers, error: findAuthError } = await supabase.auth.admin.listUsers();
      
      if (!findAuthError && authUsers.users) {
        const authUser = authUsers.users.find(user => user.email === admin.email);
        
        if (authUser) {
          // Update the user's email confirmation status
          const { error: authError } = await supabase.auth.admin.updateUserById(
            authUser.id,
            { email_confirm: true }
          );
          
          if (authError) {
            console.log('⚠️ Warning: Could not update Supabase Auth user:', authError.message);
          } else {
            console.log('✅ Admin confirmed in Supabase Auth successfully');
          }
        } else {
          console.log('⚠️ Warning: Could not find Supabase Auth user with email:', admin.email);
        }
      } else {
        console.log('⚠️ Warning: Could not list Supabase Auth users:', findAuthError?.message);
      }
    } catch (authError) {
      console.log('⚠️ Warning: Could not update Supabase Auth user:', authError.message);
      // Don't throw error here - we still want to mark the admin as verified
    }

    console.log('✅ Admin verified successfully:', admin.email);

    // Show success page with clear instructions
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Admin Account Verified Successfully</title>
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
          <div class="success">Admin Account Verified Successfully!</div>
          <div class="message">
            Hi ${admin.first_name || admin.firstname || 'Admin'},<br>
            Your admin account has been verified successfully.<br>
            You can now login to the admin portal using your email and password.
          </div>
          <div class="note">
            <strong>💡 Note:</strong> You may receive another verification email from Supabase. You can safely ignore it since your account is already verified.
          </div>
          <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}" class="login-btn">Go to Admin Login</a>
        </div>
      </body>
      </html>
    `);
    
  } catch (error) {
    console.error("🔥 Error verifying admin email:", error.message);
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
    const verificationLink = `${process.env.BACKEND_URL || 'https://idisciplineweb-backend.onrender.com'}/verify-email?token=${newToken}`;
    
    const msg = {
      to: email,
      from: { email: SENDGRID_FROM_EMAIL, name: SENDGRID_FROM_NAME },
      subject: 'MIPSS New Verification Link - Action Required',
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>MIPSS New Verification Link</title>
        </head>
        <body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f5f5f5;">
          <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff;">
            <!-- Header -->
            <div style="background-color: #274684; color: white; padding: 20px; text-align: center;">
              <h2 style="margin: 0; font-size: 24px; font-weight: bold;">MARY IMMACULATE PARISH SPECIAL SCHOOL INC.</h2>
              <p style="margin: 10px 0 0 0; font-size: 14px;">Avocado Drive, Agro Homes 1, Moonwalk Village, Talon Singko, Las Piñas City, Philippines 1747</p>
              <p style="margin: 5px 0 0 0; font-size: 12px;">Email: registrar@mipss.edu.ph | accounting@mipss.edu.ph | hrdm@mipss.edu.ph</p>
              <p style="margin: 5px 0 0 0; font-size: 12px;">Website: mipss.edu.ph</p>
            </div>
            
            <!-- Main Content -->
            <div style="padding: 40px 30px; background-color: #ffffff;">
              <h1 style="color: #274684; font-size: 28px; font-weight: bold; margin: 0 0 20px 0; text-align: center;">New Verification Link</h1>
              
              <p style="color: #333333; font-size: 16px; line-height: 1.5; margin: 0 0 20px 0;">Hello ${name},</p>
              
              <p style="color: #333333; font-size: 16px; line-height: 1.5; margin: 0 0 20px 0;">Your previous verification link has expired. Here are your new login credentials:</p>
              
              <div style="background-color: #f8f9fa; border: 1px solid #e9ecef; border-radius: 8px; padding: 20px; margin: 20px 0;">
                <h3 style="color: #274684; font-size: 18px; margin: 0 0 15px 0;">Your Updated Login Credentials:</h3>
                <p style="color: #333333; font-size: 14px; margin: 5px 0;"><strong>Email:</strong> ${email}</p>
                <p style="color: #333333; font-size: 14px; margin: 5px 0;"><strong>New Password:</strong> ${newPassword}</p>
              </div>
              
              <div style="text-align: center; margin: 30px 0;">
                <a href="${verificationLink}" style="background-color: #274684; color: #ffffff; padding: 15px 40px; text-decoration: none; border-radius: 5px; display: inline-block; font-weight: bold; font-size: 16px;">
                  Verify Your Account
                </a>
              </div>
              
              <p style="color: #666666; font-size: 14px; text-align: center; margin: 20px 0;">Or copy and paste this link into your browser:</p>
              <p style="color: #666666; font-size: 12px; word-break: break-all; background-color: #f8f9fa; padding: 10px; border-radius: 4px; margin: 10px 0;">${verificationLink}</p>
              
              <div style="background-color: #fff3cd; border: 1px solid #ffeaa7; border-radius: 5px; padding: 15px; margin: 20px 0;">
                <p style="color: #856404; margin: 0; font-size: 14px;"><strong>Security Notice:</strong> This link will expire in 24 hours for your security. If you need more time, please request another verification link.</p>
              </div>
              
              <p style="color: #333333; font-size: 14px; line-height: 1.5; margin: 20px 0;">If you have any questions or need assistance, please contact our support team.</p>
              
              <p style="color: #333333; font-size: 14px; line-height: 1.5; margin: 20px 0 0 0;">Best regards,<br>The iDiscipline Team</p>
            </div>
            
            <!-- Footer -->
            <div style="background-color: #f8f9fa; border-top: 3px solid #274684; padding: 15px; text-align: center;">
              <p style="margin: 0; color: #666; font-size: 12px;">© 2025 MIPSS — "God-Centered, Academically Excellent and Socially Responsible community of learners."</p>
            </div>
          </div>
        </body>
        </html>
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

// 3.6. Resend Admin Verification Link Route - NEW
app.post('/resend-admin-verification-link', async (req, res) => {
  const { email, name } = req.body;
  
  if (!email || !name) {
    return res.status(400).json({ 
      success: false, 
      message: 'Missing required fields: email, name' 
    });
  }

  try {
    console.log(`📧 Resending admin verification email to ${email}`);
    
    // First check if current token is expired
    const { data: admin, error: findError } = await supabase
      .from('users')
      .select('created_at, token_verification, status')
      .eq('email', email)
      .single();

    if (findError || !admin) {
      throw new Error('Admin not found');
    }

    if (admin.status === 'active') {
      return res.status(400).json({
        success: false,
        message: 'Admin is already verified'
      });
    }

    // Check if current token is expired (24 hours)
    const tokenCreated = new Date(admin.created_at);
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
    
    // Update admin with new token, password, and reset created_at for new 24-hour window
    const { error: updateError } = await supabase
      .from('users')
      .update({ 
        token_verification: newToken,
        password_hash: newPassword,
        status: 'inactive',
        created_at: new Date().toISOString() // Reset the 24-hour timer
      })
      .eq('email', email);

    if (updateError) {
      throw updateError;
    }

    // Update Supabase Auth user password
    try {
      const { data: authUsers, error: findAuthError } = await supabase.auth.admin.listUsers();
      
      if (!findAuthError && authUsers.users) {
        const authUser = authUsers.users.find(user => user.email === email);
        
        if (authUser) {
          const { error: authError } = await supabase.auth.admin.updateUserById(
            authUser.id,
            { password: newPassword }
          );
          
          if (authError) {
            console.log('⚠️ Warning: Could not update Supabase Auth user password:', authError.message);
          } else {
            console.log('✅ Supabase Auth user password updated successfully');
          }
        }
      }
    } catch (authError) {
      console.log('⚠️ Warning: Could not update Supabase Auth user password:', authError.message);
    }

    // Send new verification email
    const response = await fetch(`${BACKEND_URL}/send-admin-verification-email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email,
        name,
        password: newPassword,
        token: newToken,
        role: 'Admin'
      }),
    });

    if (response.ok) {
      console.log(`✅ New admin verification email sent to ${email}`);
      res.status(200).json({ 
        success: true, 
        message: 'New admin verification email sent successfully' 
      });
    } else {
      const errorData = await response.json();
      throw new Error(errorData.message || 'Failed to send admin verification email');
    }
    
  } catch (error) {
    console.error("🔥 Error resending admin verification email:", error.message);
    res.status(500).json({ 
      success: false, 
      message: error.message 
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
// --- Pattern-based handbook Q&A (no AI) ---
function extractTopHandbookPassages(question, fullText, options = {}) {
  const { maxPassages = 3, minLen = 40 } = options;
  if (!question || !fullText) return [];

  const normalize = (s) => s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ') 
    .trim();

  const stopwords = new Set([
    'the','a','an','and','or','but','if','then','else','for','to','of','in','on','at','by','with','from','as','is','are','was','were','be','being','been','this','that','these','those','it','its','do','does','did','can','could','should','would','may','might','will','shall','your','you','we','our','they','their'
  ]);

  const qNorm = normalize(question);
  const qTokens = qNorm.split(' ').filter(t => t && !stopwords.has(t));
  const qTokenSet = new Set(qTokens);

  // Also build simple bigrams for a bit more precision
  const qBigrams = new Set([]);
  for (let i = 0; i < qTokens.length - 1; i++) {
    qBigrams.add(qTokens[i] + ' ' + qTokens[i+1]);
  }

  // Split handbook into paragraphs/sections
  const paragraphs = fullText
    .split(/\n\s*\n+/)
    .map(p => p.trim())
    .filter(p => p.length >= minLen);

  const scored = paragraphs.map((p, idx) => {
    const pNorm = normalize(p);
    const pTokens = pNorm.split(' ').filter(Boolean);
    let unigramScore = 0;
    for (const t of pTokens) {
      if (qTokenSet.has(t)) unigramScore += 1;
    }
    // Bigram score
    let bigramScore = 0;
    for (let i = 0; i < pTokens.length - 1; i++) {
      const bg = pTokens[i] + ' ' + pTokens[i+1];
      if (qBigrams.has(bg)) bigramScore += 2; // weight bigrams higher
    }
    // Keyword proximity bonus: count distinct overlaps
    const distinctOverlap = new Set(pTokens.filter(t => qTokenSet.has(t))).size;
    const score = unigramScore + bigramScore + distinctOverlap;
    return { idx, score, text: p };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, maxPassages).filter(s => s.score > 0);
  return top.map(s => s.text);
}

app.post('/api/ask-handbook', async (req, res) => {
  const { question } = req.body;
  const pdfPath = '../public/docs/studenthandbook.pdf';
  try {
    checkRateLimit();
    if (!question || typeof question !== 'string' || question.trim().length === 0) {
      return res.status(400).json({ error: 'Question is required.' });
    }
    const dataBuffer = fs.readFileSync(pdfPath);
    const data = await pdfParse(dataBuffer);
    const pdfText = data.text || '';

    const passages = extractTopHandbookPassages(question, pdfText, { maxPassages: 3 });
    if (passages.length === 0) {
      return res.json({
        answer: 'No directly relevant section found in the handbook for that question.'
      });
    }

    const answer = passages.join('\n\n');
    res.json({ answer });
  } catch (err) {
    console.error('Chatbot error (pattern-based):', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Lightweight Web Chatbot Endpoints (aligned with mobile pattern) ---
// Derive a coarse category from a question
function deriveQuestionCategory(q) {
  const text = (q || '').toLowerCase();
  if (/dress|uniform|groom|hair|attire/.test(text)) return 'dressCode';
  if (/attend|absen|tardy|late/.test(text)) return 'attendance';
  if (/appeal|challenge|dispute|contest/.test(text)) return 'appeals';
  if (/bully/.test(text)) return 'bullying';
  if (/suspend/.test(text)) return 'suspension';
  if (/expel|expulsion|dismiss/.test(text)) return 'expulsion';
  if (/category\s*c/.test(text)) return 'categoryC';
  if (/category\s*b|cheat|plagiar|gambl|alcohol|vandal/.test(text)) return 'majorOffensesB';
  if (/category\s*a|disrespect|fight|pda|cutting|record/.test(text)) return 'majorOffensesA';
  if (/minor|id\s*violation|tardi|loiter|litter/.test(text)) return 'minorOffenses';
  if (/violation|offense|rule/.test(text)) return 'violations';
  return 'general';
}

function getCategoryList() {
  return [
    { key: 'violations', title: 'Student Conduct and Discipline' },
    { key: 'attendance', title: 'Attendance' },
    { key: 'dressCode', title: 'Dress Code' },
    { key: 'minorOffenses', title: 'Minor Offenses' },
    { key: 'majorOffensesA', title: 'Major Offenses Category A' },
    { key: 'majorOffensesB', title: 'Major Offenses Category B' },
    { key: 'categoryC', title: 'Destructive & Harmful Offenses (Category C)' },
    { key: 'bullying', title: 'Anti-Bullying' },
    { key: 'appeals', title: 'Appeals Process' },
    { key: 'suspension', title: 'Suspension' },
    { key: 'expulsion', title: 'Expulsion' }
  ];
}

function getSuggestionsForCategory(cat) {
  const s = {
    violations: [
      'What are the violation categories?',
      'What happens if I break a rule?',
      'How are violations classified?'
    ],
    attendance: [
      'What is the attendance policy?',
      'How many absences are allowed?',
      'What are sanctions for tardiness?'
    ],
    dressCode: [
      'What is the dress code?',
      'What are the grooming rules?',
      'What happens if I violate dress code?'
    ],
    minorOffenses: [
      'What are minor offenses?',
      'Sanctions for minor violations',
      'Examples of minor offenses'
    ],
    majorOffensesA: [
      'What are Major Offenses Category A?',
      'Sanctions for Category A offenses',
      'What happens for repeated violations?'
    ],
    majorOffensesB: [
      'What are Major Offenses Category B?',
      'What is the penalty for cheating?',
      'Sanctions for Category B offenses'
    ],
    categoryC: [
      'What are Category C offenses?',
      'Consequences for drugs or weapons?',
      'Fraternities or hazing consequences'
    ],
    bullying: [
      'What happens if I bully someone?',
      'How is bullying handled?',
      'Anti-bullying policy'
    ],
    suspension: [
      'What is the suspension policy?',
      'How long can I be suspended?',
      'What happens during suspension?'
    ],
    expulsion: [
      'What is expulsion?',
      'When can I be expelled?',
      'Consequences of expulsion'
    ],
    appeals: [
      'How do I appeal a decision?',
      'What is the appeals process?',
      'Can I challenge a violation?'
    ],
    general: [
      'What are the violation types?',
      'What is the dress code?',
      'What are the attendance rules?'
    ]
  };
  return s[cat] || s.general;
}

// Lightweight FAQ patterns (from mobile reference, condensed)
const CHATBOT_FAQ = {
  dressCode: {
    faqs: [
      {
        q: /((what\s+happens\s+if)\s+.*dress\s*code)|((violate|violation|break|penalt|penalty|sanction|consequence).*(dress\s*code|uniform|groom))|((dress\s*code|uniform|groom).*(violate|violation|break|penalt|penalty|sanction|consequence))/i,
        a: (
          'Dress Code sanctions (summary):\n' +
          '- 1st offense: reminder/counseling; may issue Disciplinary Notification Form (DNF).\n' +
          '- Repeated: Disciplinary Warning Form (DWF) and parent conference.\n' +
          '- Further/repeated non‑compliance: suspension possible; may be treated as Major Offense.\n' +
          'Follow grooming rules and uniform policy to avoid escalation.'
        )
      },
      {
        q: /what\s+is\s+the\s+dress\s*code|uniform|groom/i,
        a: (
          'Students must be presentable and modest.\n' +
          '- Boys: navy pants, white polo with school patch, black leather shoes, clean 2x3/3x4 haircut.\n' +
          '- Girls: gray/white checkered skirt, white blouse with patch, ribbon/tie, black shoes.\n' +
          'PE uniforms only on PE days; ID must be worn at all times.'
        )
      },
      {
        q: /.*/,
        a: (
          'Dress Code highlights:\n' +
          '- Wear school uniform and ID at all times.\n' +
          '- Follow grooming rules (clean haircut; no make‑up, long/polished nails, jewelry/piercings, tattoos).\n' +
          '- PE uniform only on PE days.'
        )
      }
    ],
    keywords: ['dress','uniform','groom','haircut','attire','clothing']
  },
  attendance: {
    faqs: [
      { q: /.*/, a: 'Absences over 20% of class days may lead to failing grade unless excused. Provide excuse letter/medical certificate; prolonged absences require parental notice.' }
    ],
    keywords: ['attendance','absent','tardy','late']
  },
  violations: {
    faqs: [
      { q: /.*/, a: 'Violations are classified as Minor Offenses, Major Offenses (Category A/B), and Category C (Destructive & Harmful). Sanctions escalate with repeats and severity.' }
    ],
    keywords: ['violation','offense','rule']
  }
};

function getFAQAnswer(category, question) {
  const entry = CHATBOT_FAQ[category];
  if (!entry) return null;
  for (const item of entry.faqs) {
    if (item.q.test(question)) return item.a;
  }
  return entry.faqs[0]?.a || null;
}

function extractTopHandbookPassagesFocused(question, fullText, focusKeywords = [], options = {}) {
  const maxPassages = options.maxPassages || 3;
  if (!fullText) return [];
  const lowerFocus = (focusKeywords || []).map(k => String(k).toLowerCase());
  const paras = fullText.split(/\n\s*\n+/).map(p => p.trim()).filter(Boolean);
  let pool = paras;
  if (lowerFocus.length > 0) {
    pool = paras.filter(p => {
      const lp = p.toLowerCase();
      return lowerFocus.some(k => lp.includes(k));
    });
    if (pool.length === 0) pool = paras; // fallback
  }
  const qTokens = String(question).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const scored = pool.map(p => {
    const lp = p.toLowerCase();
    let score = 0;
    for (const t of qTokens) if (lp.includes(t)) score += 2;
    for (const fk of lowerFocus) if (lp.includes(fk)) score += 1;
    return { p, score };
  });
  scored.sort((a,b) => b.score - a.score);
  const top = scored.slice(0, maxPassages).filter(s => s.score > 0).map(s => s.p);
  return top;
}

app.get('/api/chatbot/categories', async (_req, res) => {
  res.json({ success: true, categories: getCategoryList() });
});

app.post('/api/chatbot/ask', async (req, res) => {
  try {
    const { question } = req.body || {};
    if (!question || typeof question !== 'string') {
      return res.status(400).json({ error: 'Question is required' });
    }
    const cat = deriveQuestionCategory(question);
    // 1) Try concise FAQ answer first for this category
    const faqAnswer = getFAQAnswer(cat, question);

    // 2) Also extract focused passages from the handbook for context
    let handbookText = '';
    try {
      const pdfPath = '../public/docs/studenthandbook.pdf';
      const dataBuffer = fs.readFileSync(pdfPath);
      const parsed = await pdfParse(dataBuffer);
      const pdfText = parsed.text || '';
      const focusKeywords = (CHATBOT_FAQ[cat]?.keywords) || [];
      const passages = extractTopHandbookPassagesFocused(question, pdfText, focusKeywords, { maxPassages: 2 });
      handbookText = passages.join('\n\n');
    } catch {}

    const finalText = faqAnswer || handbookText || 'No directly relevant section found in the handbook for that question.';
    res.json({ text: finalText, suggestions: getSuggestionsForCategory(cat), category: cat, source: faqAnswer ? 'FAQ' : 'Student Handbook' });
  } catch (err) {
    console.error('chatbot ask error:', err);
    res.status(500).json({ error: 'Failed to process question' });
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

      // Only block on invalid student email format (empty or wrong format) - this is the only critical validation
      const studentEmail = row['Student Email'];
      const isEmptyEmail = !studentEmail || String(studentEmail).trim() === '';
      const hasWrongFormat = studentEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(studentEmail);
      
      if (isEmptyEmail || hasWrongFormat) {
        const errorMessage = isEmptyEmail 
          ? 'Student Email is required and cannot be empty'
          : `Invalid student email format: ${studentEmail}. Email must contain @ symbol and valid domain (e.g., student@example.com)`;
        
        errors.push({
          row: idx + 2,
          errors: [errorMessage],
          data: row
        });
        return; // Do not process further or insert
      }

      // Check for parent contact requirement (either Parent Email OR Contact No. must be provided)
      const hasParentEmail = row['Parent Email'] && String(row['Parent Email']).trim() !== '';
      const hasContactNo = row['Contact No.'] && String(row['Contact No.']).trim() !== '';
      
      if (!hasParentEmail && !hasContactNo) {
        rowErrors.push('Either Parent Email OR Contact No. must be provided for parent/guardian contact');
        // Don't return here - let it continue processing but mark as error
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
              rowErrors.push(`Invalid email format: ${value}. Email must contain @ symbol and valid domain (e.g., student@example.com)`);
            }
            break;
          case 'First Name':
          case 'Last Name':
            value = value.split(' ')
              .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
              .join(' ');
            break;
          case 'Contact No.':
            // Format contact number to standard +639XXXXXXXXX format
            if (value) {
              // Remove all spaces and special characters except +
              value = value.replace(/[\s\-\(\)]/g, '');
              
              // Handle different input formats
              if (value.startsWith('+63')) {
                // Already has +63 prefix, just ensure no spaces
                value = value;
              } else if (value.startsWith('63')) {
                // Has 63 prefix, add +
                value = `+${value}`;
              } else if (value.startsWith('0')) {
                // Has 0 prefix, replace with +63
                value = `+63${value.substring(1)}`;
              } else {
                // No prefix, add +63
                value = `+63${value}`;
              }
              
              // Validate final format (should be +63 followed by 10 digits)
              if (!/^\+63\d{10}$/.test(value)) {
                rowErrors.push(`Invalid contact number format: ${row[excelCol]}. Expected format: +63XXXXXXXXXX or 0XXXXXXXXXX or XXXXXXXXXX`);
              }
            }
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
      
      // Check for existing students to avoid duplicates
      const emails = rows.map(row => row.studentemail);
      const { data: existingStudents, error: checkError } = await supabase
        .from('students')
        .select('studentemail')
        .in('studentemail', emails);
      
      if (checkError) {
        console.error('Error checking existing students:', checkError);
      }
      
      const existingEmails = new Set(existingStudents?.map(s => s.studentemail) || []);
      const uniqueRows = rows.filter(row => !existingEmails.has(row.studentemail));
      const duplicateRows = rows.filter(row => existingEmails.has(row.studentemail));
      
      if (duplicateRows.length > 0) {
        console.log(`⚠️ Skipping ${duplicateRows.length} duplicate students:`, duplicateRows.map(r => r.studentemail));
      }
      
      if (uniqueRows.length === 0) {
        console.log('All students already exist, skipping insertion');
        return { successList: [], failList: duplicateRows.map(row => ({ ...row, error: 'Student already exists' })) };
      }
      
      // Try batch insert first
      const { data, error } = await supabase.from('students').insert(uniqueRows).select();
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
      for (const row of uniqueRows) {
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
        // Check if Supabase Auth user already exists
        console.log(`🔍 Checking if Supabase Auth user exists for ${student.studentemail}...`);
        
        const { data: existingUsers, error: listError } = await supabase.auth.admin.listUsers();
        const existingUser = existingUsers?.users?.find(user => user.email === student.studentemail);
        
        if (existingUser) {
          console.log(`⚠️ Supabase Auth user already exists for ${student.studentemail}, skipping creation`);
          verificationEmailsSent++;
          continue; // Skip to next student
        }
        
        // Create the Supabase Auth user
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
        const response = await fetch(`${BACKEND_URL}/send-verification-email`, {
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

// 5.5. Send Admin Verification Email Route - NEW
app.post('/send-admin-verification-email', async (req, res) => {
  const { email, name, password, token, role } = req.body;
  
  if (!email || !name || !password || !token) {
    return res.status(400).json({ 
      success: false, 
      message: 'Missing required fields: email, name, password, token' 
    });
  }

  try {
    console.log(`📧 Sending admin verification email to ${email} with token: ${token}`);
    
    const verificationLink = `${process.env.BACKEND_URL || 'https://idisciplineweb-backend.onrender.com'}/verify-admin-email?token=${token}`;
    
    const msg = {
      to: email,
      from: { email: SENDGRID_FROM_EMAIL, name: SENDGRID_FROM_NAME },
      subject: 'MIPSS Admin Account Verification - Action Required',
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>MIPSS Admin Account Verification</title>
        </head>
        <body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f5f5f5;">
          <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff;">
            <!-- Header -->
            <div style="background-color: #274684; color: white; padding: 20px; text-align: center;">
              <h2 style="margin: 0; font-size: 24px; font-weight: bold;">MARY IMMACULATE PARISH SPECIAL SCHOOL INC.</h2>
              <p style="margin: 10px 0 0 0; font-size: 14px;">Avocado Drive, Agro Homes 1, Moonwalk Village, Talon Singko, Las Piñas City, Philippines 1747</p>
              <p style="margin: 5px 0 0 0; font-size: 12px;">Email: registrar@mipss.edu.ph | accounting@mipss.edu.ph | hrdm@mipss.edu.ph</p>
              <p style="margin: 5px 0 0 0; font-size: 12px;">Website: mipss.edu.ph</p>
            </div>
            
            <!-- Main Content -->
            <div style="padding: 40px 30px; background-color: #ffffff;">
              <h1 style="color: #274684; font-size: 28px; font-weight: bold; margin: 0 0 20px 0; text-align: center;">Admin Account Verification</h1>
              
              <p style="color: #333333; font-size: 16px; line-height: 1.5; margin: 0 0 20px 0;">Hello ${name},</p>
              
              <p style="color: #333333; font-size: 16px; line-height: 1.5; margin: 0 0 20px 0;">We received a request to verify your admin account for the iDiscipline system. If you didn't make this request, you can safely ignore this email.</p>
              
              <div style="background-color: #f8f9fa; border: 1px solid #e9ecef; border-radius: 8px; padding: 20px; margin: 20px 0;">
                <h3 style="color: #274684; font-size: 18px; margin: 0 0 15px 0;">Your Login Credentials:</h3>
                <p style="color: #333333; font-size: 14px; margin: 5px 0;"><strong>Email:</strong> ${email}</p>
                <p style="color: #333333; font-size: 14px; margin: 5px 0;"><strong>Password:</strong> ${password}</p>
                <p style="color: #333333; font-size: 14px; margin: 5px 0;"><strong>Role:</strong> ${role || 'Admin'}</p>
              </div>
              
              <div style="text-align: center; margin: 30px 0;">
                <a href="${verificationLink}" style="background-color: #274684; color: #ffffff; padding: 15px 40px; text-decoration: none; border-radius: 5px; display: inline-block; font-weight: bold; font-size: 16px;">
                  Verify Admin Account
                </a>
              </div>
              
              <p style="color: #666666; font-size: 14px; text-align: center; margin: 20px 0;">Or copy and paste this link into your browser:</p>
              <p style="color: #666666; font-size: 12px; word-break: break-all; background-color: #f8f9fa; padding: 10px; border-radius: 4px; margin: 10px 0;">${verificationLink}</p>
              
              <div style="background-color: #fff3cd; border: 1px solid #ffeaa7; border-radius: 5px; padding: 15px; margin: 20px 0;">
                <p style="color: #856404; margin: 0; font-size: 14px;"><strong>Security Notice:</strong> This link will expire in 24 hours for your security. If you need more time, please request another verification link.</p>
              </div>
              
              <p style="color: #333333; font-size: 14px; line-height: 1.5; margin: 20px 0;">If you have any questions or need assistance, please contact our support team.</p>
              
              <p style="color: #333333; font-size: 14px; line-height: 1.5; margin: 20px 0 0 0;">Best regards,<br>The iDiscipline Team</p>
            </div>
            
            <!-- Footer -->
            <div style="background-color: #f8f9fa; border-top: 3px solid #274684; padding: 15px; text-align: center;">
              <p style="margin: 0; color: #666; font-size: 12px;">© 2025 MIPSS — "God-Centered, Academically Excellent and Socially Responsible community of learners."</p>
            </div>
          </div>
        </body>
        </html>
      `,
      text: `Welcome to iDiscipline Admin Portal!\n\nHi ${name},\n\nYour admin account has been created successfully. Here are your login credentials:\n\nEmail: ${email}\nPassword: ${password}\nRole: ${role || 'Admin'}\n\n⚠️ IMPORTANT: You may receive another email from Supabase. Please use THIS verification link instead.\n\nTo complete your admin account setup, please visit this verification link:\n${verificationLink}\n\n💡 Tip: After clicking the verification link above, you can ignore any other verification emails you receive.\n\nThis link will expire in 24 hours. If you didn't create this account, please ignore this email.`
    };

    await sgMail.send(msg);
    console.log(`✅ Admin verification email sent successfully to ${email}`);
    
    res.status(200).json({ 
      success: true, 
      message: 'Admin verification email sent successfully',
      verificationLink 
    });
    
  } catch (error) {
    console.error('💥 Error sending admin verification email:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to send admin verification email', 
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
    from: { email: SENDGRID_FROM_EMAIL, name: SENDGRID_FROM_NAME },
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

// 7. Send SMS to parent
app.post('/send-parent-sms', async (req, res) => {
  console.log('🚀 SMS endpoint hit on Vercel!');
  console.log('🔑 SEMAPHORE_API_KEY exists:', !!SEMAPHORE_API_KEY);
  console.log('📱 SEMAPHORE_SENDER_NAME:', SEMAPHORE_SENDER_NAME);
  
  const { 
    parentPhone, 
    parentName, 
    studentName, 
    violationCategory, 
    violationType, 
    timeReported, 
    notes, 
    status,
    // Appointment fields
    messageType,
    appointmentType,
    appointmentDate,
    appointmentTime,
    location,
    caseNumber
  } = req.body;
  
  console.log('📥 SMS Request body:', req.body);

  if (!parentPhone || !parentName || !studentName) {
    return res.status(400).json({ success: false, message: 'Missing required fields.' });
  }

  // Format phone number for Semaphore API
  console.log('📞 Original phone number:', parentPhone);
  let formattedPhone = parentPhone.replace(/\D/g, ''); // Remove all non-digits
  console.log('📞 After removing non-digits:', formattedPhone);
  
  // Semaphore API expects format like 09123456789 (without +63)
  if (formattedPhone.startsWith('63')) {
    // If it starts with 63, remove it and add 0
    formattedPhone = '0' + formattedPhone.substring(2);
  } else if (formattedPhone.startsWith('+63')) {
    // If it starts with +63, remove +63 and add 0
    formattedPhone = '0' + formattedPhone.substring(3);
  } else if (!formattedPhone.startsWith('0')) {
    // If it doesn't start with 0, add 0
    formattedPhone = '0' + formattedPhone;
  }
  
  console.log('📞 Final formatted phone for Semaphore:', formattedPhone);

  // Create SMS message based on message type
  let message;
  
  console.log('📱 SMS Request Debug:', {
    messageType,
    appointmentType,
    appointmentDate,
    appointmentTime,
    location,
    caseNumber,
    parentName,
    studentName
  });
  
  console.log('📱 MessageType check:', {
    messageType,
    type: typeof messageType,
    strictEqual: messageType === 'appointment',
    looseEqual: messageType == 'appointment'
  });
  
  console.log('📱 Appointment data check:', {
    appointmentType,
    appointmentDate,
    appointmentTime,
    location,
    caseNumber,
    notes
  });
  
  if (messageType === 'appointment') {
    // Appointment SMS format
    console.log('📱 Using appointment SMS format');
    message = `Dear ${parentName},\n\nThis is to inform you about your child's Parent-Teacher Conference (PTC) appointment at Mary Immaculate Parish Special School.\n\nStudent: ${studentName}\nAppointment Type: ${appointmentType || 'PTC'}\nDate: ${appointmentDate || 'N/A'}\nTime: ${appointmentTime || 'N/A'}\nLocation: ${location || 'School Office'}\nStatus: ${status || 'N/A'}\nCase Number: ${caseNumber || 'N/A'}\nNotes: ${notes || 'No additional details provided.'}\n\nIf you have any questions or concerns, please contact the school office.\n\nThis is an automated message from iDiscipline.`;
  } else {
    // Default violation SMS format
    console.log('📱 Using violation SMS format (messageType:', messageType, ')');
    console.log('📱 Violation data check:', {
      violationCategory,
      violationType,
      timeReported,
      notes,
      status
    });
    message = `Dear ${parentName},\n\nThis is to inform you that your child, ${studentName}, has been reported for a disciplinary incident at school.\n\nStatus: ${status || 'N/A'}\nViolation Category: ${violationCategory || 'N/A'}\nViolation Type: ${violationType || 'N/A'}\nTime Reported: ${timeReported || 'N/A'}\nNotes: ${notes || 'N/A'}\n\nIf you have any questions or concerns, please contact the school office.\n\nThis is an automated message from iDiscipline.`;
  }

  try {
    const result = await sendSMS(formattedPhone, message);
    
    if (result.success) {
      res.status(200).json({ success: true, message: 'Parent notification SMS sent successfully.' });
    } else {
      res.status(500).json({ success: false, message: 'Failed to send parent notification SMS.', error: result.error });
    }
  } catch (error) {
    console.error('💥 Error sending parent notification SMS:', error);
    res.status(500).json({ success: false, message: 'Failed to send parent notification SMS.', error: error.message });
  }
});

// ===== PUSH NOTIFICATION ROUTES =====

// 1. Register push token route
app.post('/push/register', async (req, res) => {
  const { userId, expoPushToken, deviceType, deviceId, appVersion } = req.body;
  
  if (!userId || !expoPushToken) {
    return res.status(400).json({ 
      success: false, 
      message: 'Missing required fields: userId, expoPushToken' 
    });
  }

  try {
    console.log(`📱 Registering push token for user: ${userId}`);
    
    // Upsert push token
    const { error } = await supabase
      .from('user_push_tokens')
      .upsert([{
        user_id: userId,
        push_token: expoPushToken,
        device_type: deviceType || 'android',
        is_active: true,
        device_id: deviceId,
        app_version: appVersion || '1.0.0',
        updated_at: new Date().toISOString()
      }], {
        onConflict: 'user_id,push_token'
      });

    if (error) {
      throw error;
    }

    console.log(`✅ Push token registered successfully for user: ${userId}`);
    res.status(200).json({ 
      success: true, 
      message: 'Push token registered successfully' 
    });
    
  } catch (error) {
    console.error('💥 Error registering push token:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to register push token', 
      error: error.message 
    });
  }
});

// 2. Deactivate push token route (on logout)
app.post('/push/deactivate', async (req, res) => {
  const { userId, pushToken } = req.body;
  
  if (!userId || !pushToken) {
    return res.status(400).json({ 
      success: false, 
      message: 'Missing required fields: userId, pushToken' 
    });
  }

  try {
    console.log(`📱 Deactivating push token for user: ${userId}`);
    
    const { error } = await supabase
      .from('user_push_tokens')
      .update({ 
        is_active: false, 
        updated_at: new Date().toISOString() 
      })
      .eq('user_id', userId)
      .eq('push_token', pushToken);

    if (error) {
      throw error;
    }

    console.log(`✅ Push token deactivated successfully for user: ${userId}`);
    res.status(200).json({ 
      success: true, 
      message: 'Push token deactivated successfully' 
    });
    
  } catch (error) {
    console.error('💥 Error deactivating push token:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to deactivate push token', 
      error: error.message 
    });
  }
});

// 3. Send push notification to a specific student
app.post('/push/send-to-student', async (req, res) => {
  const { studentId, title, body, data } = req.body;
  
  if (!studentId || !title || !body) {
    return res.status(400).json({ 
      success: false, 
      message: 'Missing required fields: studentId, title, body' 
    });
  }

  try {
    console.log(`📱 Sending push notification to student: ${studentId}`);
    
    // Get active push tokens for the student
    const { data: tokens, error: tokenError } = await supabase
      .from('user_push_tokens')
      .select('push_token')
      .eq('user_id', studentId)
      .eq('is_active', true);

    if (tokenError) {
      throw tokenError;
    }

    if (!tokens || tokens.length === 0) {
      console.log(`⚠️ No active push tokens found for student: ${studentId}`);
      return res.json({ 
        success: true, 
        sent: 0, 
        message: 'No active push tokens found for this student' 
      });
    }

    // Prepare messages for Expo
    const messages = tokens.map(token => ({
      to: token.push_token,
      title,
      body,
      data: data || {}
    }));

    // Send to Expo
    const expoResult = await sendExpoPush(messages);
    
    if (!expoResult.success) {
      throw new Error(expoResult.error);
    }

    // Log the notification
    await logPushNotification(
      studentId,
      title,
      body,
      'student',
      'student',
      tokens.map(t => t.push_token),
      expoResult.data
    );

    console.log(`✅ Push notification sent to student: ${studentId} (${tokens.length} tokens)`);
    res.json({ 
      success: true, 
      count: tokens.length,
      message: `Push notification sent to ${tokens.length} device(s)` 
    });
    
  } catch (error) {
    console.error('💥 Error sending push notification to student:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to send push notification', 
      error: error.message 
    });
  }
});

// 4. Send push notification to all DOs (Disciplinary Officers)
app.post('/push/send-to-dos', async (req, res) => {
  const { title, body, data } = req.body;
  
  if (!title || !body) {
    return res.status(400).json({ 
      success: false, 
      message: 'Missing required fields: title, body' 
    });
  }

  try {
    console.log('📱 Sending push notification to all DOs');
    
    // Get all active DOs
    const { data: doUsers, error: doError } = await supabase
      .from('users')
      .select('id')
      .in('role', ['admin', 'super_admin'])
      .eq('status', 'active');

    if (doError) {
      throw doError;
    }

    if (!doUsers || doUsers.length === 0) {
      console.log('⚠️ No active DOs found');
      return res.json({ 
        success: true, 
        sent: 0, 
        message: 'No active DOs found' 
      });
    }

    const doUserIds = doUsers.map(u => u.id);

    // Get push tokens for all DOs
    const { data: tokens, error: tokenError } = await supabase
      .from('user_push_tokens')
      .select('user_id, push_token')
      .eq('is_active', true)
      .in('user_id', doUserIds);

    if (tokenError) {
      throw tokenError;
    }

    if (!tokens || tokens.length === 0) {
      console.log('⚠️ No active push tokens found for DOs');
      return res.json({ 
        success: true, 
        sent: 0, 
        message: 'No active push tokens found for DOs' 
      });
    }

    // Prepare messages for Expo
    const messages = tokens.map(token => ({
      to: token.push_token,
      title,
      body,
      data: data || {}
    }));

    // Send to Expo in chunks of 100
    let totalSent = 0;
    for (let i = 0; i < messages.length; i += 100) {
      const chunk = messages.slice(i, i + 100);
      const expoResult = await sendExpoPush(chunk);
      
      if (expoResult.success) {
        totalSent += chunk.length;
      } else {
        console.error(`❌ Failed to send chunk ${i}-${i + chunk.length}:`, expoResult.error);
      }
    }

    // Log the notification for each DO
    for (const token of tokens) {
      await logPushNotification(
        token.user_id,
        title,
        body,
        'admin',
        'admin',
        [token.push_token],
        { sent: totalSent }
      );
    }

    console.log(`✅ Push notification sent to DOs: ${totalSent} messages`);
    res.json({ 
      success: true, 
      count: totalSent,
      message: `Push notification sent to ${totalSent} device(s)` 
    });
    
  } catch (error) {
    console.error('💥 Error sending push notification to DOs:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to send push notification', 
      error: error.message 
    });
  }
});

// 5. Send push notification when new incident report is filed
app.post('/push/incident-report-notification', async (req, res) => {
  const { incidentId, studentName, violationCategory, violationType } = req.body;
  
  if (!incidentId || !studentName || !violationCategory || !violationType) {
    return res.status(400).json({ 
      success: false, 
      message: 'Missing required fields: incidentId, studentName, violationCategory, violationType' 
    });
  }

  try {
    console.log(`📱 Sending incident report notification for incident: ${incidentId}`);
    
    const title = 'New Incident Report';
    const body = `${studentName} • ${violationCategory} – ${violationType}`;
    const data = { 
      type: 'incident_report', 
      incidentId 
    };

    // Use the existing send-to-dos route
    const response = await fetch(`${BACKEND_URL}/push/send-to-dos`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title, body, data })
    });

    const result = await response.json();
    
    if (result.success) {
      console.log(`✅ Incident report notification sent: ${result.count} messages`);
      res.json({ 
        success: true, 
        count: result.count,
        message: `Incident report notification sent to ${result.count} device(s)` 
      });
    } else {
      throw new Error(result.message);
    }
    
  } catch (error) {
    console.error('💥 Error sending incident report notification:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to send incident report notification', 
      error: error.message 
    });
  }
});

// 6. Send push notification when appointment is created
app.post('/push/appointment-notification', async (req, res) => {
  const { appointmentId, studentId, doName, type, date, time, caseNo } = req.body;
  
  if (!appointmentId || !studentId || !doName || !type || !date || !time) {
    return res.status(400).json({ 
      success: false, 
      message: 'Missing required fields: appointmentId, studentId, doName, type, date, time' 
    });
  }

  try {
    console.log(`📱 Sending appointment notification for appointment: ${appointmentId}`);
    
    const title = 'Appointment Scheduled';
    const body = `${doName}: ${type} on ${date} ${time}`;
    const data = { 
      type: 'appointment', 
      appointmentId, 
      case_no: caseNo 
    };

    // Use the existing send-to-student route
    const response = await fetch(`${BACKEND_URL}/push/send-to-student`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ studentId, title, body, data })
    });

    const result = await response.json();
    
    if (result.success) {
      console.log(`✅ Appointment notification sent: ${result.count} messages`);
      res.json({ 
        success: true, 
        count: result.count,
        message: `Appointment notification sent to ${result.count} device(s)` 
      });
    } else {
      throw new Error(result.message);
    }
    
  } catch (error) {
    console.error('💥 Error sending appointment notification:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to send appointment notification', 
      error: error.message 
    });
  }
});

// 7. Send chat message notification
app.post('/push/chat-message-notification', async (req, res) => {
  const { chatId, senderName, message, recipientId, recipientType, studentName } = req.body;
  
  if (!chatId || !senderName || !message || !recipientId || !recipientType) {
    return res.status(400).json({ 
      success: false, 
      message: 'Missing required fields: chatId, senderName, message, recipientId, recipientType' 
    });
  }

  try {
    console.log(`📱 Sending chat message notification for chat: ${chatId}`);
    
    let title, body, data;
    
    if (recipientType === 'student') {
      // DO → student
      title = 'New message';
      body = message.length > 50 ? message.substring(0, 50) + '...' : message;
      data = { type: 'message', chatId };
      
      // Send to student
      const response = await fetch(`${BACKEND_URL}/push/send-to-student`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ 
          studentId: recipientId, 
          title, 
          body, 
          data 
        })
      });

      const result = await response.json();
      
      if (result.success) {
        console.log(`✅ Chat message notification sent to student: ${result.count} messages`);
        res.json({ 
          success: true, 
          count: result.count,
          message: `Chat message notification sent to ${result.count} device(s)` 
        });
      } else {
        throw new Error(result.message);
      }
      
    } else {
      // Student → DOs
      title = 'Student message';
      body = `${studentName || 'Student'}: ${message.length > 50 ? message.substring(0, 50) + '...' : message}`;
      data = { type: 'message', chatId };
      
      // Send to DOs
      const response = await fetch(`${BACKEND_URL}/push/send-to-dos`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title, body, data })
      });

      const result = await response.json();
      
      if (result.success) {
        console.log(`✅ Chat message notification sent to DOs: ${result.count} messages`);
        res.json({ 
          success: true, 
          count: result.count,
          message: `Chat message notification sent to ${result.count} device(s)` 
        });
      } else {
        throw new Error(result.message);
      }
    }
    
  } catch (error) {
    console.error('💥 Error sending chat message notification:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to send chat message notification', 
      error: error.message 
    });
  }
});

// Add new endpoint for personality test analysis
app.post('/api/analyze-personality', async (req, res) => {
  const { answers, violations } = req.body;
  
  try {
    checkRateLimit();
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

    const message = await anthropic.messages.create({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 1000,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ]
    });

    const analysis = message.content[0].text;

    res.json({ analysis });
  } catch (err) {
    console.error('Personality analysis error:', err);
    if (err.type === 'rate_limit_error') {
      res.status(429).json({ 
        error: 'Rate limit exceeded. Please try again in a few minutes.',
        retryAfter: '1 minute'
      });
    } else {
      res.status(500).json({ error: err.message });
    }
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
  console.log('AI suggestion request received:', { category, summaryLength: summary?.length });
  
  try {
    checkRateLimit();
    
    // Check Anthropic API key first
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error('ANTHROPIC_API_KEY is not set');
      return res.status(500).json({ 
        error: 'AI service not configured',
        details: 'ANTHROPIC_API_KEY environment variable is not set'
      });
    }
    
    // Load handbook text (assuming PDF is in public/docs/studenthandbook.pdf)
    const path = require('path');
    const pdfPath = path.join(__dirname, '../public/docs/studenthandbook.pdf');
    
    console.log('Looking for PDF at:', pdfPath);
    console.log('Current working directory:', process.cwd());
    console.log('__dirname:', __dirname);
    
    // Check if PDF file exists
    let handbookText = '';
    if (!fs.existsSync(pdfPath)) {
      console.error('Student handbook PDF not found at:', pdfPath);
      
      // Try alternative paths
      const altPaths = [
        path.join(__dirname, 'public/docs/studenthandbook.pdf'),
        path.join(process.cwd(), 'public/docs/studenthandbook.pdf'),
        path.join(process.cwd(), 'docs/studenthandbook.pdf')
      ];
      
      console.log('Trying alternative paths:', altPaths);
      let pdfFound = false;
      for (const altPath of altPaths) {
        if (fs.existsSync(altPath)) {
          console.log('Found PDF at alternative path:', altPath);
          const dataBuffer = fs.readFileSync(altPath);
          const data = await pdfParse(dataBuffer);
          handbookText = data.text;
          console.log('PDF parsed successfully, text length:', handbookText.length);
          pdfFound = true;
          break;
        }
      }
      
      if (!pdfFound) {
        console.log('PDF not found, using fallback handbook text');
        // Fallback handbook text for when PDF is not available
        handbookText = `
        STUDENT HANDBOOK - DISCIPLINARY POLICIES
        
        General Disciplinary Guidelines:
        - Students are expected to maintain appropriate behavior at all times
        - Respect for teachers, staff, and fellow students is required
        - Academic integrity must be maintained
        - School property must be treated with care
        
        Common Violations:
        - Tardiness and absenteeism
        - Disruptive behavior in class
        - Inappropriate language or conduct
        - Damage to school property
        - Academic dishonesty
        
        Disciplinary Actions:
        - Verbal warnings for minor infractions
        - Written warnings for repeated violations
        - Parent/guardian notification
        - Detention or community service
        - Suspension for serious violations
        
        Appeal Process:
        - Students may appeal disciplinary decisions
        - Appeals must be submitted within 48 hours
        - Parent/guardian involvement is encouraged
        `;
      }
    } else {
      console.log('PDF found, reading file...');
      const dataBuffer = fs.readFileSync(pdfPath);
      console.log('PDF file size:', dataBuffer.length, 'bytes');
      
      const data = await pdfParse(dataBuffer);
      handbookText = data.text;
      console.log('PDF parsed successfully, text length:', handbookText.length);
    }

    // Compose prompt with truncated handbook text to reduce token usage
    const truncatedHandbook = handbookText.substring(0, 8000); // Limit to ~8000 characters
    const prompt = `You are a helpful school discipline analyst. Using the student handbook excerpt and the provided data summary, write a SHORT, structured markdown report for the category "${category}". Keep items concise, concrete, and school-appropriate. Do not include prefaces or concluding fluff. Use the following section order and headings exactly. Where a section has no signal, omit it. Also analyze TOP CAUSES from the summary (topCauses/causesByType) and propose targeted resolutions.

Data Summary (JSON):
${summary}

Student Handbook Excerpt (for reference only):
${truncatedHandbook}

Output format (markdown):
### Trends Noticed
- item

### Immediate Actions
- item

### Follow-up Steps
- item

### Prevention Strategies
- item

### Demographics Insights
- item

### Comparative Analysis
- item

### Possible Underlying Reasons
- item

### Records Needed
- item

### Overall Recommendation
- single short paragraph

Additional Required Focus:
- Top Causes Analysis: identify top 2-3 recurring causes from data summary (topCauses/causesByType)
- For each, state likely root causes and give concrete resolution steps the DO team can implement within the next month

Constraints:
- Max 6 bullets per list.
- Be specific (who/what/when) and actionable.
- Reference handbook practices only when helpful (no citations).`;

    console.log('Sending request to Anthropic API...');
    console.log('Prompt length:', prompt.length);
    
    const message = await anthropic.messages.create({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 1000,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ]
    });

    console.log('Anthropic API response received');
    const suggestion = message.content[0].text;
    console.log('Suggestion generated, length:', suggestion.length);

    res.json({ suggestion });
  } catch (err) {
    console.error('AI suggestion error:', err);
    console.error('Error details:', {
      message: err.message,
      type: err.type,
      stack: err.stack,
      anthropicApiKey: process.env.ANTHROPIC_API_KEY ? 'SET' : 'NOT SET'
    });
    
    if (err.message && err.message.includes('Rate limit exceeded')) {
      res.status(429).json({ 
        error: 'Rate limit exceeded. Please try again in a few minutes.',
        retryAfter: '1 minute'
      });
    } else if (err.type === 'rate_limit_error') {
      res.status(429).json({ 
        error: 'Rate limit exceeded. Please try again in a few minutes.',
        retryAfter: '1 minute'
      });
    } else if (!process.env.ANTHROPIC_API_KEY) {
      res.status(500).json({ 
        error: 'AI service not configured. Missing API key.',
        details: 'ANTHROPIC_API_KEY environment variable is not set'
      });
    } else {
      res.status(500).json({ 
        error: err.message || 'Internal server error',
        details: 'Check server logs for more information'
      });
    }
  }
});

// Securely delete a Supabase Auth user (service role required)
app.post('/api/delete-auth-user', async (req, res) => {
  try {
    const { email, userId } = req.body || {};

    if (!email && !userId) {
      return res.status(400).json({ success: false, message: 'Provide email or userId' });
    }

    let targetUserId = userId;
    if (!targetUserId && email) {
      const normalized = String(email).toLowerCase();
      // First try GoTrue Admin API direct email lookup (most reliable)
      try {
        const resp = await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(normalized)}`, {
          method: 'GET',
          headers: {
            'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json'
          }
        });
        if (resp.ok) {
          const data = await resp.json();
          // GoTrue may return an array or an object with { users: [] }
          const users = Array.isArray(data) ? data : (data && data.users ? data.users : []);
          if (users && users.length > 0) {
            const matched = users.find(u => (u.email || '').toLowerCase() === normalized) || users[0];
            targetUserId = matched?.id || targetUserId;
          }
        }
      } catch (gtErr) {
        console.log('GoTrue email lookup failed, falling back to pagination:', gtErr?.message);
      }

      // Fallback: robust search across pages via SDK if still not found
      if (!targetUserId) {
        let page = 1;
        const perPage = 1000;
        let found = null;
        while (page <= 10 && !found) {
          const { data: authUsers, error: listErr } = await supabase.auth.admin.listUsers({ page, perPage });
          if (listErr) {
            throw listErr;
          }
          const users = authUsers?.users || [];
          found = users.find(u => (u.email || '').toLowerCase() === normalized);
          if (users.length < perPage) break; // no more pages
          page += 1;
        }
        if (!found) {
          return res.status(404).json({ success: false, message: 'Auth user not found for provided email' });
        }
        targetUserId = found.id;
      }
    }

    const { error: delErr } = await supabase.auth.admin.deleteUser(targetUserId);
    if (delErr) {
      throw delErr;
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('Error deleting auth user:', err);
    return res.status(500).json({ success: false, message: err.message });
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
      from: { email: SENDGRID_FROM_EMAIL, name: SENDGRID_FROM_NAME },
      subject: 'MIPSS Password Reset - Action Required',
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>MIPSS Password Reset</title>
        </head>
        <body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f5f5f5;">
          <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff;">
            <!-- Header -->
            <div style="background-color: #274684; color: white; padding: 20px; text-align: center;">
              <h2 style="margin: 0; font-size: 24px; font-weight: bold;">MARY IMMACULATE PARISH SPECIAL SCHOOL INC.</h2>
              <p style="margin: 10px 0 0 0; font-size: 14px;">Avocado Drive, Agro Homes 1, Moonwalk Village, Talon Singko, Las Piñas City, Philippines 1747</p>
              <p style="margin: 5px 0 0 0; font-size: 12px;">Email: registrar@mipss.edu.ph | accounting@mipss.edu.ph | hrdm@mipss.edu.ph</p>
              <p style="margin: 5px 0 0 0; font-size: 12px;">Website: mipss.edu.ph</p>
            </div>
            
            <!-- Main Content -->
            <div style="padding: 40px 30px; background-color: #ffffff;">
              <h1 style="color: #274684; font-size: 28px; font-weight: bold; margin: 0 0 20px 0; text-align: center;">Password Reset Request</h1>
              
              <p style="color: #333333; font-size: 16px; line-height: 1.5; margin: 0 0 20px 0;">Hello ${userData.firstname} ${userData.lastname},</p>
              
              <p style="color: #333333; font-size: 16px; line-height: 1.5; margin: 0 0 20px 0;">We received a request to reset your password for your iDiscipline account. If you didn't make this request, you can safely ignore this email.</p>
              
              <div style="text-align: center; margin: 30px 0;">
                <a href="${resetLink}" style="background-color: #274684; color: #ffffff; padding: 15px 40px; text-decoration: none; border-radius: 5px; display: inline-block; font-weight: bold; font-size: 16px;">
                  Reset Your Password
                </a>
              </div>
              
              <p style="color: #666666; font-size: 14px; text-align: center; margin: 20px 0;">Or copy and paste this link into your browser:</p>
              <p style="color: #666666; font-size: 12px; word-break: break-all; background-color: #f8f9fa; padding: 10px; border-radius: 4px; margin: 10px 0;">${resetLink}</p>
              
              <div style="background-color: #fff3cd; border: 1px solid #ffeaa7; border-radius: 5px; padding: 15px; margin: 20px 0;">
                <p style="color: #856404; margin: 0; font-size: 14px;"><strong>Security Notice:</strong> This link will expire in 1 hour for your security. If you need more time, please request another password reset.</p>
              </div>
              
              <p style="color: #333333; font-size: 14px; line-height: 1.5; margin: 20px 0;">If you have any questions or need assistance, please contact our support team.</p>
              
              <p style="color: #333333; font-size: 14px; line-height: 1.5; margin: 20px 0 0 0;">Best regards,<br>The iDiscipline Team</p>
            </div>
            
            <!-- Footer -->
            <div style="background-color: #f8f9fa; border-top: 3px solid #274684; padding: 15px; text-align: center;">
              <p style="margin: 0; color: #666; font-size: 12px;">© 2025 MIPSS — "God-Centered, Academically Excellent and Socially Responsible community of learners."</p>
            </div>
          </div>
        </body>
        </html>
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



