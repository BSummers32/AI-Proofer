const { GoogleGenerativeAI } = require("@google/generative-ai");

exports.handler = async (event, context) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    // We now expect 'mimeType' and 'isBinary' flags from the frontend
    const { content, mediaType, mimeType, isBinary } = JSON.parse(event.body);

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    // 1. Define Tone Logic
    let toneInstruction = "";
    switch (mediaType) {
      case "signage": toneInstruction = "Focus on brevity, high impact, and clarity."; break;
      case "social": toneInstruction = "Focus on engagement, hashtags, and a casual/fun tone."; break;
      case "policy": toneInstruction = "Focus on professional, formal, and legally precise language."; break;
      default: toneInstruction = "Focus on readability and grammar.";
    }

    // 2. Construct the Prompt Text
    const systemPrompt = `
      You are a professional content editor. 
      Task: Proofread the provided content for a ${mediaType} context. ${toneInstruction}
      
      Return ONLY a raw JSON array of objects. Do not use Markdown code blocks.
      Each object must have these exact keys:
      - "id": A unique number
      - "original": The exact substring from the text that needs changing (if reading an image/pdf, transcribe the text exactly as it appears)
      - "fix": The suggested replacement
      - "reason": A brief explanation (max 10 words)
    `;

    // 3. Prepare the Payload for Gemini
    let parts = [{ text: systemPrompt }];

    if (isBinary) {
      // For PDF/Images, we pass the Base64 data directly
      parts.push({
        inlineData: {
          mimeType: mimeType,
          data: content // This is the base64 string
        }
      });
    } else {
      // For plain text files
      parts.push({ text: `Text to review:\n"${content}"` });
    }

    // 4. Call Gemini
    const result = await model.generateContent(parts);
    const response = await result.response;
    let text = response.text();

    // Clean up Markdown if present
    text = text.replace(/```json/g, "").replace(/```/g, "").trim();

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: text,
    };

  } catch (error) {
    console.error("Error details:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Processing failed", details: error.message }),
    };
  }
};
