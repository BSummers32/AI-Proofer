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
        case "digital": toneInstruction = "Focus on readability and SEO."; break;
        default: toneInstruction = "Focus on readability and grammar.";
      }

      const videoInstruction = mimeType.startsWith("video/") ? 
        "This is a video file. Analyze the visual text (titles, chyrons, signage) AND the spoken audio transcript for errors. Treat spoken words as the 'content'." : "";

      // FIX #9: Grouping Instruction Added
      systemPrompt = `
        You are a professional content editor for ${mediaType}. ${toneInstruction}
        ${videoInstruction}
        
        CONTEXT:
        - Target Audience: ${targetAudience}
        - Custom Style Guide: ${styleGuide}
        
        INSTRUCTIONS:
        1. Identify grammatical errors, tone inconsistencies, and clarity issues.
        2. CRITICAL: Group repetitive errors into a single suggestion. For example, if there are 5 capitalization errors in a list, DO NOT list them individually. Instead, provide ONE suggestion like "Capitalize all list items" and show one example in the 'original' field.
        3. Return ONLY a raw JSON array of objects.
        
        Each object must have:
        - "id": A unique number
        - "original": The exact text snippet (or a representative example if grouping)
        - "fix": The suggested replacement (or a summary of the fix if grouping)
        - "reason": A brief explanation of the error or improvement
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
      // Decode base64 to text if it's not binary (unlikely in this flow but good safety)
      // Actually for text files we might need to decode, but Gemini handles text in inlineData too for some mimeTypes.
      // Safest is to treat everything as inlineData if we have base64
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