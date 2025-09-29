const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

// Test SMS functionality
async function testSMS() {
  const SEMAPHORE_API_KEY = process.env.SEMAPHORE_API_KEY;
  const SEMAPHORE_SENDER_NAME = process.env.SEMAPHORE_SENDER_NAME || 'iDiscipline';

  if (!SEMAPHORE_API_KEY) {
    console.error('❌ SEMAPHORE_API_KEY not found in environment variables');
    return;
  }

  console.log('🧪 Testing SMS functionality with Semaphore API...');
  console.log('📱 Sender Name:', SEMAPHORE_SENDER_NAME);
  console.log('🔑 API Key:', SEMAPHORE_API_KEY.substring(0, 10) + '...');

  // Test phone number (replace with a real number for testing)
  const testPhoneNumber = '09282731202'; // Format: 09123456789
  const testMessage = 'Test message from iDiscipline system. This is a test SMS to verify the integration works correctly.';

  try {
    // Semaphore API expects parameters as query parameters, not in body
    const params = new URLSearchParams({
      apikey: SEMAPHORE_API_KEY,
      number: testPhoneNumber,
      message: testMessage,
      sendername: SEMAPHORE_SENDER_NAME
    });
    
    const response = await fetch(`https://api.semaphore.co/api/v4/messages?${params}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      }
    });

    const result = await response.json();
    
    if (response.ok) {
      console.log('✅ SMS test successful!');
      console.log('📊 Response:', result);
    } else {
      console.error('❌ SMS test failed:', result);
    }
  } catch (error) {
    console.error('💥 Error during SMS test:', error.message);
  }
}

// Run the test
testSMS();
