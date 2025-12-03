const { GoogleGenerativeAI } = require("@google/generative-ai");

exports.handler = async (event, context) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: "Method Not Allowed" };
  }

  const apiKey = process.env.GEMINI_API_KEY;

  try {
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is missing in Netlify.");
    }

    const payload = JSON.parse(event.body);
    const { 
      mode = "analyze", 
      content, 
      mediaType, 
      mimeType, 
      isBinary, 
      expectedEdits = [],
      // New Context Fields
      targetAudience = "General Audience",
      styleGuide = "Standard Grammar Rules"
    } = payload;

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" }); 
    
    let systemPrompt = "";
    
    if (mode === "verify") {
      const editsList = expectedEdits.map(e => `- Change "${e.original}" to "${e.fix}"`).join("\n");
      systemPrompt = `
        You are a content verification engine.
        Verify if the following edits were implemented.
        Expected Edits: ${editsList}
        Return ONLY a raw JSON array of objects with keys: "fix", "status" ('verified'/'failed'), "comment".
      `;
    } else {
      let toneInstruction = "";
      switch (mediaType) {
        case "signage": toneInstruction = "Focus on brevity, high impact, and clarity."; break;
        case "social": toneInstruction = "Focus on engagement, hashtags, and a casual/fun tone."; break;
        case "policy": toneInstruction = "Focus on professional, formal, and legally precise language."; break;
        default: toneInstruction = "Focus on readability and grammar.";
      }

      systemPrompt = `
        You are a professional content editor for ${mediaType}. ${toneInstruction}
        
        CONTEXT:
        - Target Audience: ${targetAudience}
        - Custom Style Guide: ${styleGuide}
        
        Return ONLY a raw JSON array of objects.
        Each object must have:
        - "id": A unique number
        - "original": The exact text to change
        - "fix": The suggested replacement
        - "reason": A brief explanation
        - "confidence": "High", "Medium", or "Low" (Based on grammar rules vs stylistic preference)
      `;
    }

    let parts = [{ text: systemPrompt }];

    if (isBinary) {
      parts.push({ inlineData: { mimeType: mimeType, data: content } });
    } else {
      parts.push({ text: `Document content:\n"${content}"` });
    }

    const result = await model.generateContent(parts);
    const response = await result.response;
    let text = response.text();

    text = text.replace(/```json/g, "").replace(/```/g, "").trim();

    return {
      statusCode: 200,
      headers,
      body: text,
    };

  } catch (error) {
    console.error("Gemini API Error:", error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "AI Model Error", details: error.message }),
    };
  }
};
