const fetch = require('node-fetch');

const BACKEND_URL = 'http://localhost:5000';

async function testPushNotifications() {
  console.log('🧪 Testing Push Notification System for iDisciplineWeb-backend');
  console.log('=' .repeat(60));

  try {
    // Test 1: Register a push token
    console.log('\n1️⃣ Testing push token registration...');
    const registerResponse = await fetch(`${BACKEND_URL}/push/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userId: '123e4567-e89b-12d3-a456-426614174000',
        expoPushToken: 'ExponentPushToken[test-token-backend-123]',
        deviceType: 'android',
        deviceId: 'test-device-123',
        appVersion: '1.0.0'
      })
    });

    const registerResult = await registerResponse.json();
    console.log('✅ Register response:', registerResult);

    // Test 2: Send notification to student
    console.log('\n2️⃣ Testing send notification to student...');
    const studentResponse = await fetch(`${BACKEND_URL}/push/send-to-student`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        studentId: '123e4567-e89b-12d3-a456-426614174000',
        title: 'Test Student Notification',
        body: 'This is a test notification from the backend server',
        data: {
          test: true,
          timestamp: new Date().toISOString()
        }
      })
    });

    const studentResult = await studentResponse.json();
    console.log('✅ Student notification response:', studentResult);

    // Test 3: Send notification to DOs
    console.log('\n3️⃣ Testing send notification to DOs...');
    const dosResponse = await fetch(`${BACKEND_URL}/push/send-to-dos`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: 'Test DO Notification',
        body: 'This is a test notification for disciplinary officers',
        data: {
          test: true,
          timestamp: new Date().toISOString()
        }
      })
    });

    const dosResult = await dosResponse.json();
    console.log('✅ DO notification response:', dosResult);

    // Test 4: Send incident report notification
    console.log('\n4️⃣ Testing incident report notification...');
    const incidentResponse = await fetch(`${BACKEND_URL}/push/incident-report-notification`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        incidentId: 'incident-123',
        studentName: 'John Doe',
        violationCategory: 'Major Type A',
        violationType: 'Disrespect to Authority'
      })
    });

    const incidentResult = await incidentResponse.json();
    console.log('✅ Incident report notification response:', incidentResult);

    // Test 5: Send appointment notification
    console.log('\n5️⃣ Testing appointment notification...');
    const appointmentResponse = await fetch(`${BACKEND_URL}/push/appointment-notification`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        appointmentId: 'appointment-123',
        studentName: 'Jane Smith',
        appointmentType: 'PTC',
        appointmentDate: '2024-01-15',
        appointmentTime: '10:00 AM'
      })
    });

    const appointmentResult = await appointmentResponse.json();
    console.log('✅ Appointment notification response:', appointmentResult);

    // Test 6: Send chat message notification
    console.log('\n6️⃣ Testing chat message notification...');
    const chatResponse = await fetch(`${BACKEND_URL}/push/chat-message-notification`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        violationId: 'violation-123',
        senderName: 'Admin User',
        message: 'This is a test chat message',
        recipientId: '123e4567-e89b-12d3-a456-426614174000'
      })
    });

    const chatResult = await chatResponse.json();
    console.log('✅ Chat message notification response:', chatResult);

    // Test 7: Deactivate push token
    console.log('\n7️⃣ Testing push token deactivation...');
    const deactivateResponse = await fetch(`${BACKEND_URL}/push/deactivate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userId: '123e4567-e89b-12d3-a456-426614174000',
        expoPushToken: 'ExponentPushToken[test-token-backend-123]'
      })
    });

    const deactivateResult = await deactivateResponse.json();
    console.log('✅ Deactivate response:', deactivateResult);

    console.log('\n🎉 All push notification tests completed!');
    console.log('=' .repeat(60));

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error('Full error:', error);
  }
}

// Run the tests
testPushNotifications();
