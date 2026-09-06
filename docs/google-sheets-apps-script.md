Google Sheets Apps Script: simple receiver for student exports

Overview
- This Apps Script receives a JSON POST containing `{ students: [...] }` and appends rows to a Google Sheet.

Script template
```javascript
function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents || '{}');
    const students = payload.students || payload.users || [];
    const ss = SpreadsheetApp.openById('YOUR_SHEET_ID'); // replace
    const sheet = ss.getSheetByName('Sheet1') || ss.getSheets()[0];

    // Prepare header if empty
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(['email','name','role','createdAt','notes']);
    }

    students.forEach(s => {
      const email = s.email || s.login || '';
      const name = s.name || s.displayName || '';
      const role = s.role || '';
      const createdAt = s.createdAt || '';
      const notes = s.notes || '';
      sheet.appendRow([email, name, role, createdAt, notes]);
    });

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, count: students.length }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
```

Deployment steps
1. Open https://script.google.com and create a new project.
2. Paste the script above and replace `YOUR_SHEET_ID` with the target sheet ID from the sheet URL.
3. Save, then choose `Deploy` → `New deployment` → `Web app`.
4. Set `Execute as` to `Me` and `Who has access` to `Anyone` (or `Anyone with Google account` if preferred).
5. Deploy and copy the Web App URL. Use that URL as the `sheets-endpoint` in the teacher UI.

Notes
- Apps Script web apps require authentication choices; if you choose `Anyone`, the endpoint is publicly callable and may be spammed — consider adding a simple secret token in the URL path and checking it in `doPost`.
- CORS: Browser POSTs from the PWA should work; if you encounter CORS issues, consider deploying as `Anyone` and POSTing from the client.
- For structured exports (columns), update the `appendRow` mapping to match your desired fields.

Example client payload
```json
{
  "students": [ { "email": "s1@gmail.com", "name": "Оля", "role": "student" } ]
}
```

Troubleshooting
- If you get a 403 from the Apps Script, redeploy and ensure access is set correctly.
- To test, use `curl`:
```bash
curl -X POST -H "Content-Type: application/json" -d '{"students":[{"email":"a@b.com"}]}' 'YOUR_WEB_APP_URL'
```
