// Test phone number formatting for Semaphore API

function formatPhoneForSemaphore(phoneNumber) {
  console.log('📞 Original phone number:', phoneNumber);
  let formattedPhone = phoneNumber.replace(/\D/g, ''); // Remove all non-digits
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
  return formattedPhone;
}

// Test different phone number formats
const testNumbers = [
  '+639282731202',  // From your example
  '09282731202',    // Without +
  '639282731202',   // Without +
  '9282731202',     // Without 0
  '+63 928 273 1202', // With spaces
  '0928-273-1202'   // With dashes
];

console.log('🧪 Testing phone number formatting for Semaphore API:\n');

testNumbers.forEach((number, index) => {
  console.log(`Test ${index + 1}:`);
  const formatted = formatPhoneForSemaphore(number);
  console.log(`Result: ${formatted}`);
  console.log('---');
});
