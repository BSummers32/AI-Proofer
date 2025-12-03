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
    const { mode = "analyze", content, mediaType, mimeType, isBinary, expectedEdits = [] } = payload;

    const genAI = new GoogleGenerativeAI(apiKey);
    
    // START: Model Selection
    // We will try the standard 1.5 Flash. 
    // If this fails, the 'catch' block below will tell us what IS available.
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" }); 
    // END: Model Selection

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
      systemPrompt = `
        You are a professional content editor for ${mediaType}.
        Return ONLY a raw JSON array of objects with keys: "id", "original", "fix", "reason".
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

    // --- DIAGNOSTICS: FETCH AVAILABLE MODELS ---
    let diagnosticMsg = "";
    try {
        // This manually asks Google "What models can I use?"
        const listReq = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
        const listData = await listReq.json();
        if (listData.models) {
            const modelNames = listData.models.map(m => m.name.replace('models/', '')).join(", ");
            diagnosticMsg = ` | AVAILABLE MODELS DETECTED: [ ${modelNames} ]`;
        } else {
            diagnosticMsg = " | Could not list models. API Key might be invalid.";
        }
    } catch (diagError) {
        diagnosticMsg = " | Diagnostics failed.";
    }
    // --------------------------------------------

    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: "AI Model Error", 
        details: (error.message || "Unknown error") + diagnosticMsg 
      }),
    };
  }
};
