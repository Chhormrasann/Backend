import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { OpenAI } from 'openai';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

// Environment Validation
if (!process.env.OPENAI_API_KEY) {
  console.warn("WARNING: OPENAI_API_KEY is missing. AI chat will fail.");
}

// Middleware
app.use(cors());
app.use(express.json());

// Health Check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    env: {
      port: port,
      hasOpenAIKey: !!process.env.OPENAI_API_KEY
    }
  });
});

// OpenAI / Hugging Face Router Setup
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

//////////////////////////////////////////////////////////////////
// 🔥 PROMPT LIBRARY
//////////////////////////////////////////////////////////////////
const promptLibrary = {
  ui: (userInput) => ({
    role: "system",
    content: `
You are a Senior UI Architect and Frontend Expert at CodeLume.
Your goal is to generate production-ready, accessible, and high-performance UI components using modern best practices.

Rules for Code:
- Return ONLY HTML + CSS (use Tailwind classes if possible, as it's cleaner).
- Ensure mobile-first responsive design.
- Use semantic HTML and include ARIA labels for accessibility.
- Focus on clean class naming and modern aesthetics (glassmorphism, soft gradients, smooth transitions).
- Provide ONLY the code in a single code block.

Rules for Explanation (The "30-Second Drill"):
- After the code block, provide exactly 3-sentence architectural breakdown.
- Explain WHY you chose specific layout techniques (e.g., Flexbox vs. Grid) and CSS properties.
- This breakdown is for a student audience to learn better engineering.
IMPORTANT: For complex requests like POS systems or dashboards, PROVIDE THE COMPLETE CODE. DO NOT TRUNCATE.

User request: ${userInput}
`
  }),

  code: (userInput) => ({
    role: "system",
    content: `
You are a senior software engineer.

Rules:
- Return clean, optimized code
- No explanation unless asked
- Follow best practices

User request: ${userInput}
`
  }),

  sql: (userInput) => ({
    role: "system",
    content: `
You are a database expert.

Rules:
- Write optimized SQL queries
- Use best practices
- No explanation unless asked

User request: ${userInput}
`
  }),

  refinement: (userInput) => ({
    role: "system",
    content: `
You are a Senior UI Architect at CodeLume.
The user wants to refine an existing piece of code.

Rules:
- Analyze the provided code and the user's refinement instruction.
- Return the UPDATED code block ONLY (HTML + CSS/Tailwind).
- Ensure the refinement is applied accurately while maintaining the high quality of the original.
- After the code block, provide a 1-sentence explanation of what changed.

User request: ${userInput}
`
  }),

  senior: (userInput) => ({
    role: "system",
    content: `
You are a senior AI coding assistant at CodeLume.
Target User:
- Software Developers: Professionals looking for a quick AI assistant to assist with code refactoring or debugging.
- Computer Science Students: Learners seeking clear explanations for programming concepts and coding patterns.
- Tech Hobbyists: Enthusiasts building personal projects who want to experiment with AI integration in their applications.

Instruction:
- Please provide complete, production-quality, and fully functional code solutions. 
- Do not use placeholders. 
- Ensure the output is well-formatted and easy to read.
- If generating a web UI, return a single HTML file with integrated CSS and JS.

User request: ${userInput}
`
  }),

  general: (userInput) => ({
    role: "system",
    content: `
You are a Senior AI Coding Assistant at CodeLume.
Explain clearly and simply for developers, students, and hobbyists.
Always provide complete, production-quality code.

User request: ${userInput}
`
  }),

  debug: (userInput) => ({
    role: "system",
    content: `
You are a Debugging Expert at CodeLume.
Analyze the provided code and find efficient solutions for errors.
Identify the bug and suggest a fix.

User request: ${userInput}
`
  }),

  explain: (userInput) => ({
    role: "system",
    content: `
You are a Software Engineering Educator at CodeLume.
Explain concepts clearly and use metaphors where helpful.
Simplify complex patterns for learners.

User request: ${userInput}
`
  }),

  game: (userInput) => ({
    role: "system",
    content: `
You are a Senior Game Developer and Creative Technologist at CodeLume.
Your goal is to generate modern, engaging, and high-performance web-based games.

Rules for Code:
- Return a SINGLE HTML file containing all HTML, CSS, and JavaScript.
- Use modern Web APIs (Canvas API, Web Audio API, etc.) or lightweight libraries like Phaser or PixiJS (via CDN).
- Ensure the game is responsive and playable on both desktop and mobile.
- Use high-quality visual aesthetics (smooth animations, particles, polished UI).
- Include essential game loops (update, draw) and state management.
- Provide ONLY the code in a single code block.

Rules for Explanation (The "Level Up Breakaway"):
- After the code block, provide a quick summary of the game mechanics and the technology used.
- Explain how the core game loop works in this specific implementation.
- This breakdown is for a student audience to learn game engineering.
IMPORTANT: Provide COMPLETE, playable code. DO NOT TRUNCATE.

User request: ${userInput}
`
  })
};

//////////////////////////////////////////////////////////////////
// 🔥 INTENT DETECTION
//////////////////////////////////////////////////////////////////
function detectPromptType(input) {
  const text = input.toLowerCase();

  if (text.includes("refine this code") || text.includes("instruction:")) return "refinement";

  if (
    text.includes("ui") ||
    text.includes("html") ||
    text.includes("css") ||
    text.includes("design") ||
    text.includes("login") ||
    text.includes("form") ||
    text.includes("component") ||
    text.includes("navbar") ||
    text.includes("card") ||
    text.includes("layout") ||
    text.includes("dashboard")
  ) return "ui";

  if (
    text.includes("sql") ||
    text.includes("database") ||
    text.includes("query") ||
    text.includes("table")
  ) return "sql";

  if (
    text.includes("code") ||
    text.includes("javascript") ||
    text.includes("java") ||
    text.includes("php") ||
    text.includes("python") ||
    text.includes("script") ||
    text.includes("function")
  ) return "code";

  if (
    text.includes("game") ||
    text.includes("arcade") ||
    text.includes("canvas") ||
    text.includes("phaser") ||
    text.includes("pixi") ||
    text.includes("rpg") ||
    text.includes("shooter") ||
    text.includes("platformer") ||
    text.includes("snake") ||
    text.includes("puzzle")
  ) return "game";

  return "senior";
}

//////////////////////////////////////////////////////////////////
// 🔥 CHAT API (STREAMING SSE)
//////////////////////////////////////////////////////////////////
app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Messages array is required' });
  }

  // Set headers for streaming (SSE)
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const lastUserMessage = messages[messages.length - 1].content;
    const promptType = detectPromptType(lastUserMessage);

    const { type: frontendType } = req.body;
    let selectedType = frontendType || promptType;

    // Ensure we have a valid mapping
    if (!promptLibrary[selectedType]) {
      selectedType = 'senior'; // Default
    }

    const systemPrompt = promptLibrary[selectedType](lastUserMessage);

    const requestedModel = "gpt-5"; // High quality coding model

    const stream = await client.chat.completions.create({
      model: requestedModel,
      messages: [systemPrompt, ...messages],
      stream: true,
      max_tokens: 8192,
      temperature: 0.7,
    }, { timeout: 120000 }); // Increase timeout to 120 seconds

    try {
      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content || "";
        if (content) {
          res.write(`data: ${JSON.stringify({ content })}\n\n`);
        }
      }
      res.write('data: [DONE]\n\n');
    } catch (streamError) {
      console.error('Stream processing error:', streamError);
      res.write(`data: ${JSON.stringify({ error: 'Stream cut off', details: streamError.message })}\n\n`);
    }

    res.end();
  } catch (error) {
    console.error('Full Error from AI Router:', error);
    const errorMessage = error.message || 'Unknown error';
    res.write(`data: ${JSON.stringify({ error: 'Failed to get response from AI', details: errorMessage })}\n\n`);
    res.end();
  }
});

//////////////////////////////////////////////////////////////////
// 🔥 CODE EXECUTION API
//////////////////////////////////////////////////////////////////
app.post('/api/execute', (req, res) => {
  const { language, code } = req.body;

  const id = uuidv4();
  const tempDir = path.join(process.cwd(), 'temp_exec');

  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

  let command = '';
  let filename = '';

  if (language === 'php') {
    filename = `exec_${id}.php`;
    fs.writeFileSync(path.join(tempDir, filename), code);
    command = `php ${path.join(tempDir, filename)}`;

  } else if (language === 'java') {
    const classNameMatch = code.match(/class\s+(\w+)/);
    const className = classNameMatch
      ? classNameMatch[1]
      : `Exec_${id.replace(/-/g, '')}`;

    let javaCode = code;

    if (!classNameMatch) {
      javaCode = `
public class ${className} {
  public static void main(String[] args) {
    ${code}
  }
}`;
    }

    filename = `${className}.java`;
    fs.writeFileSync(path.join(tempDir, filename), javaCode);
    command = `javac ${path.join(tempDir, filename)} && java -cp ${tempDir} ${className}`;

  } else {
    return res.status(400).json({ error: 'Language not supported' });
  }

  exec(command, (error, stdout, stderr) => {
    try {
      const filePath = path.join(tempDir, filename);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

      if (language === 'java') {
        const classFile = filename.replace('.java', '.class');
        const classPath = path.join(tempDir, classFile);
        if (fs.existsSync(classPath)) fs.unlinkSync(classPath);
      }
    } catch (err) {
      console.error('Cleanup Error:', err);
    }

    if (error) {
      return res.json({ output: stderr || error.message, error: true });
    }
    res.json({ output: stdout });
  });
});

//////////////////////////////////////////////////////////////////
// 🚀 START SERVER
//////////////////////////////////////////////////////////////////
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});