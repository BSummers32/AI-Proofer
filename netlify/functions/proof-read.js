const { GoogleGenerativeAI } = require("@google/generative-ai");

exports.handler = async (event, context) => {
  // 1. CORS Headers (Optional but good for debugging)
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: "Method Not Allowed" };
  }

  try {
    // 2. Check API Key immediately
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error("CRITICAL: GEMINI_API_KEY is missing in Netlify Environment Variables.");
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: "Configuration Error", details: "GEMINI_API_KEY is missing. Please add it to Netlify Site Settings." })
      };
    }

    const payload = JSON.parse(event.body);
    const { 
      mode = "analyze", 
      content, 
      mediaType, 
      mimeType, 
      isBinary,
      expectedEdits = [] 
    } = payload;

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    let systemPrompt = "";
    
    // 3. Prompt Logic
    if (mode === "verify") {
      const editsList = expectedEdits.map(e => `- Change "${e.original}" to "${e.fix}"`).join("\n");
      systemPrompt = `
        You are a content verification engine.
        Task: Review the provided document and verify if the following edits were implemented.
        
        Expected Edits:
        ${editsList}

        Return ONLY a raw JSON array of objects.
        Each object must contain:
        - "fix": The expected fix
        - "status": "verified" or "failed"
        - "comment": Brief explanation.
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
        You are a professional content editor. 
        Task: Proofread the content for a ${mediaType} context. ${toneInstruction}
        
        Return ONLY a raw JSON array of objects.
        Each object must have:
        - "id": A unique number
        - "original": The exact text to change
        - "fix": The suggested replacement
        - "reason": A brief explanation
      `;
    }

    let parts = [{ text: systemPrompt }];

    if (isBinary) {
      parts.push({
        inlineData: {
          mimeType: mimeType,
          data: content
        }
      });
    } else {
      parts.push({ text: `Document content:\n"${content}"` });
    }

    // 4. Call Gemini
    const result = await model.generateContent(parts);
    const response = await result.response;
    let text = response.text();

    // 5. Clean Response
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
      body: JSON.stringify({ error: "AI Processing Failed", details: error.message || error.toString() }),
    };
  }
};
