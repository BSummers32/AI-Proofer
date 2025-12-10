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
      fileUrl,      
      mediaType, 
      mimeType, 
      isBinary, 
      expectedEdits = [],
      targetAudience = "General Audience",
      styleGuide = "Standard Grammar Rules"
    } = payload;

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" }); 
    
    // INJECT CURRENT DATE
    const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

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
      // ENHANCED PROMPT LOGIC FOR MARKETING
      switch (mediaType) {
        case "signage": 
          toneInstruction = "CONTEXT: PRINTED SIGNAGE. Focus on high impact and brevity. IGNORE sentence fragments and exclamation points—they are desired for effect."; 
          break;
        case "social": 
          toneInstruction = "CONTEXT: SOCIAL MEDIA. Focus on engagement. Slang, emojis, exclamation points, and casual grammar are EXPECTED and should NOT be flagged."; 
          break;
        case "policy": 
          toneInstruction = "CONTEXT: CORPORATE POLICY. Focus on professional, formal, and legally precise language. Strict grammar applies."; 
          break;
        case "digital": 
          toneInstruction = "CONTEXT: WEB CONTENT. Focus on readability and SEO. fragments are okay for headers, but body text should be grammatical."; 
          break;
        default: 
          toneInstruction = "Focus on readability and grammar.";
      }

      const videoInstruction = mimeType.startsWith("video/") ? 
        "This is a video file. Analyze the visual text (titles, chyrons, signage) AND the spoken audio transcript for errors. Treat spoken words as the 'content'." : "";

      systemPrompt = `
        You are a professional content editor for ${mediaType}. 
        ${toneInstruction}
        ${videoInstruction}
        
        CONTEXT:
        - Current Date: ${today} (Use this to flag outdated years/dates).
        - Target Audience: ${targetAudience}
        - Custom Style Guide: ${styleGuide}
        
        INSTRUCTIONS:
        1. Identify ACTUAL errors (typos, wrong dates, misleading info).
        2. DO NOT flag stylistic choices typical for ${mediaType}.
        3. If the text is "punchy" or uses sentence fragments for marketing effect, ACCEPT IT.
        4. CRITICAL: Group repetitive errors into a single suggestion.
        5. Return ONLY a raw JSON array of objects.
        
        Each object must have:
        - "id": A unique number
        - "original": The exact text snippet
        - "fix": The suggested replacement
        - "reason": A brief explanation.
        - "confidence": "High", "Medium", or "Low"
      `;
    }

    let parts = [{ text: systemPrompt }];

    // Handle Content (URL)
    let finalData = null;
    if (fileUrl) {
      console.log(`Fetching content from: ${fileUrl}`);
      const fileResp = await fetch(fileUrl);
      if (!fileResp.ok) throw new Error("Failed to fetch file from storage URL");
      const arrayBuffer = await fileResp.arrayBuffer();
      finalData = Buffer.from(arrayBuffer).toString("base64");
    }

    if (isBinary && finalData) {
      parts.push({ inlineData: { mimeType: mimeType, data: finalData } });
    } else if (finalData) {
      parts.push({ inlineData: { mimeType: mimeType, data: finalData } });
    } else {
      throw new Error("No content provided (fileUrl required)");
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
