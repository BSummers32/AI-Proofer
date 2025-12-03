const { GoogleGenerativeAI } = require("@google/generative-ai");

exports.handler = async (event, context) => {
  // Only allow POST requests
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const { content, mediaType } = JSON.parse(event.body);

    // Initialize Gemini API
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    // Construct the prompt based on media type
    let toneInstruction = "";
    switch (mediaType) {
      case "signage": toneInstruction = "Focus on brevity, high impact, and clarity."; break;
      case "social": toneInstruction = "Focus on engagement, hashtags, and a casual/fun tone."; break;
      case "policy": toneInstruction = "Focus on professional, formal, and legally precise language."; break;
      default: toneInstruction = "Focus on readability and grammar.";
    }

    const prompt = `
      You are a professional content editor. 
      Task: Proofread the following text for a ${mediaType} context. ${toneInstruction}
      
      Return ONLY a raw JSON array of objects. Do not use Markdown code blocks. 
      Each object must have these exact keys:
      - "id": A unique number
      - "original": The exact substring from the text that needs changing
      - "fix": The suggested replacement
      - "reason": A brief explanation (max 10 words)

      Text to review:
      "${content}"
    `;

    // Generate content
    const result = await model.generateContent(prompt);
    const response = await result.response;
    let text = response.text();

    // Clean up if the model returns markdown code fences despite instructions
    text = text.replace(/```json/g, "").replace(/```/g, "").trim();

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: text,
    };

  } catch (error) {
    console.error("Error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to process content", details: error.message }),
    };
  }
};
