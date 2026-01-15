import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { google } from "googleapis";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SCOPES = ["https://www.googleapis.com/auth/drive.readonly"];
const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  },
  scopes: SCOPES,
});

const drive = google.drive({ version: "v3", auth });
const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;

let vectorStoreId: string | null = process.env.TEST_VECTOR_STORE_ID || null;

async function getFilesFromGoogleDrive() {
  try {
    const response = await drive.files.list({
      q: `'${FOLDER_ID}' in parents and mimeType contains 'pdf'`,
      fields: "files(id, name, mimeType)",
    });

    const files = response.data.files || [];
    console.log(files);

    const fileStreams = await Promise.all(
      files.map(async (file) => {
        const fileResponse = await drive.files.get(
          { fileId: file.id!, alt: "media" },
          { responseType: "stream" }
        );

        const chunks: Buffer[] = [];
        for await (const chunk of fileResponse.data) {
          chunks.push(chunk);
        }
        const buffer = Buffer.concat(chunks);

        return {
          name: file.name!,
          buffer: buffer,
        };
      })
    );

    return fileStreams;
  } catch (error) {
    console.error("Error fetching files from Google Drive:", error);
    throw error;
  }
}

export async function POST(req: NextRequest) {
  const { message, conversationId } = await req.json();

  try {
    if (!vectorStoreId) {
      const vectorStore = await openai.vectorStores.create({
        name: "POC Knowledge Base",
      });
      vectorStoreId = vectorStore.id;

      const files = await getFilesFromGoogleDrive();

      await openai.vectorStores.fileBatches.uploadAndPoll(vectorStoreId, {
        files: files.map((file) => new File([file.buffer], file.name)),
      });
    }

    let conversation;
    if (!conversationId) {
      conversation = await openai.conversations.create();
    } else {
      conversation = { id: conversationId };
    }

    await openai.conversations.items.create(conversation.id, {
      items: [
        {
          role: "user",
          content: message,
        },
      ],
    });

    const response = await openai.responses.create({
      model: "gpt-4o-mini",
      input: message,
      tools: [
        {
          type: "file_search",
          vector_store_ids: [vectorStoreId],
        },
      ],
    });

    return NextResponse.json({
      conversationId: conversation.id,
      response: response.output_text,
    });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "Something went wrong" },
      { status: 500 }
    );
  }
}
