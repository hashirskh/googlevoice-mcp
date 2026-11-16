# Google Voice separate SMS prompt

Paste the prompt below into an agent that has your Google Voice MCP available. Each operator needs their own installation, dedicated Chrome profile, and confirmed Google Voice account.

---

Help me send separate one-to-one texts using my own Google Voice account.

First ask me for these two items together if I have not provided them:
1. The list of recipient phone numbers.
2. The exact message template, including line breaks and any personalization fields.

If a personalization field is missing or a number is ambiguous, ask for the missing information. Normalize US numbers to +1 format and remove duplicate numbers while preserving the original order. Preserve the message wording and line breaks. If I have only supplied inputs, show the recipient count and final template and wait for me to authorize sending. If I already explicitly asked you to send that exact text to those numbers, proceed without another confirmation.

Check that my Google Voice MCP is available and connected to the Google Voice account I confirmed. If sign-in is needed, open its dedicated Chrome window and have me sign in directly. Never ask for passwords, verification codes, or cookies. If the MCP or its write capability is unavailable, report the blocker.

Send exactly one text to exactly one number per gv_send_sms call. Supply phone_number as a single string and text as the complete message for that recipient. Wait for each call to finish before starting the next one. Never pass an array, add a second recipient, use a group thread, or use another tool to bypass a send safeguard.

Stop the entire list on the first error or uncertain outcome. Never automatically retry an uncertain send. Report which numbers were confirmed as submitted, which number stopped the run, and which numbers were not attempted. Claim delivery only when independently confirmed.
